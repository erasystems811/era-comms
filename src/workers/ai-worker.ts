// ── AI CONVERSATION WORKER ────────────────────────────────────
//
// Processes AIConversationJob from the `ai` BullMQ queue.
// Triggered by the inbound worker after each inbound message on a
// conversation where ai_active = true.
//
// Per-job flow:
//   1. Build conversation context (profile + message history)
//   2. Skip if ai_active = false or status != 'active'
//   3. Check escalation triggers in latest inbound message
//   4. Classify → route → AI provider
//   5. Call provider.complete()
//   6. Send reply via sendMessage() with aiGenerated = true
//   7. Enqueue message.sent webhook event

import { Worker, Queue } from 'bullmq'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { sendMessage } from '../services/messaging.js'
import { buildConversationContext } from '../ai/context.js'
import { taskClassifier } from '../ai/classifier.js'
import { aiRouter } from '../ai/router.js'
import { QUEUE } from '../queues/definitions.js'
import type { AIConversationJob, WebhookDeliveryJob, AnalyticsJob } from '../queues/definitions.js'

const log = logger.child({ component: 'ai-worker' })

type WebhookEndpointRow = { id: string }
type DeliveryRow        = { id: string }

// Shared queues — created once, not per-job
const webhookQueue   = new Queue<WebhookDeliveryJob>(QUEUE.webhooks,   { connection: { url: config.redis.url } })
const analyticsQueue = new Queue<AnalyticsJob>(QUEUE.analytics,         { connection: { url: config.redis.url } })

async function escalateConversation(
  conversationId: string,
  clientId: string,
  reason: string,
): Promise<void> {
  // Mark conversation escalated
  await adminDb`
    UPDATE conversations
    SET status            = 'escalated',
        escalated_at      = NOW(),
        escalation_reason = ${reason},
        updated_at        = NOW()
    WHERE id = ${conversationId}
  `

  // Fire conversation.escalated webhook
  const endpoints = (await adminDb`
    SELECT id FROM webhook_endpoints
    WHERE client_id = ${clientId}
      AND status    = 'active'
      AND 'conversation.escalated' = ANY(events)
  `) as unknown as WebhookEndpointRow[]

  if (endpoints.length === 0) return

  const payload = JSON.stringify({
    event: 'conversation.escalated',
    data:  { conversationId, reason },
  })

  await Promise.all(
    endpoints.map(async (ep) => {
      const dRows = (await adminDb`
        INSERT INTO webhook_deliveries (endpoint_id, client_id, event_type, payload)
        VALUES (${ep.id}, ${clientId}, 'conversation.escalated', ${payload}::jsonb)
        RETURNING id
      `) as unknown as DeliveryRow[]

      const deliveryId = dRows[0]?.id
      if (!deliveryId) return

      await webhookQueue.add(
        'webhook',
        { deliveryId },
        { attempts: 10, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true },
      )
    }),
  )
}

async function processAI(job: { data: AIConversationJob }): Promise<void> {
  const { conversationId, clientId, messageId } = job.data

  log.debug({ conversationId, messageId }, 'Processing AI response')

  // Build context — loads profile, history, and signals in one pass
  const ctx = await buildConversationContext(conversationId, clientId)

  if (!ctx) {
    log.warn({ conversationId }, 'Conversation or profile not found — skipping')
    return
  }

  // Skip if human has taken over or conversation is no longer active
  if (!ctx.aiActive || ctx.conversationStatus !== 'active') {
    log.debug({ conversationId, status: ctx.conversationStatus }, 'AI not active — skipping')
    return
  }

  // ── ESCALATION TRIGGER CHECK ────────────────────────────────
  //
  // Check before calling the AI. If the inbound message matches an
  // escalation trigger, hand off to a human immediately.

  if (ctx.signals.hasEscalationKeywords) {
    log.info({ conversationId }, 'Escalation trigger detected — escalating')
    await escalateConversation(
      conversationId,
      clientId,
      `Escalation trigger in: "${ctx.latestInboundContent.slice(0, 100)}"`,
    )
    return
  }

  // ── CLASSIFY AND ROUTE ──────────────────────────────────────

  const taskType = taskClassifier.classify(ctx.signals)
  const provider = aiRouter.forTask(taskType)

  log.debug({ conversationId, taskType, providerId: provider.providerId }, 'Routing to provider')

  // ── GENERATE RESPONSE ───────────────────────────────────────

  let aiResponse:    string
  let aiModel:       string
  let inputTokens  = 0
  let outputTokens = 0

  try {
    const result = await provider.complete(ctx.messages, {
      maxTokens:   500,
      temperature: 0.7,
    })
    aiResponse   = result.content.trim()
    aiModel      = result.model
    inputTokens  = result.inputTokens
    outputTokens = result.outputTokens
  } catch (err) {
    log.error({ conversationId, err }, 'AI provider call failed')
    throw err // let BullMQ retry
  }

  if (!aiResponse) {
    log.warn({ conversationId }, 'AI returned empty response — skipping send')
    return
  }

  // ── SEND REPLY ──────────────────────────────────────────────
  //
  // Load the session ID from the conversation to route the send correctly.

  const convRows = (await adminDb`
    SELECT session_id FROM conversations WHERE id = ${conversationId}
  `) as unknown as Array<{ session_id: string }>

  const sessionId = convRows[0]?.session_id
  if (!sessionId) {
    log.warn({ conversationId }, 'No session_id on conversation — cannot send reply')
    return
  }

  // Load the contact phone number from the conversation + contact join
  const contactRows = (await adminDb`
    SELECT c.phone_number
    FROM   contacts c
    JOIN   conversations conv ON conv.contact_id = c.id
    WHERE  conv.id = ${conversationId}
  `) as unknown as Array<{ phone_number: string }>

  const to = contactRows[0]?.phone_number
  if (!to) {
    log.warn({ conversationId }, 'No contact phone number found — cannot send reply')
    return
  }

  try {
    await sendMessage({
      clientId,
      sessionId,
      to,
      content:        aiResponse,
      contentType:    'text',
      conversationId,
      aiGenerated:    true,
    })
  } catch (err) {
    log.error({ conversationId, err }, 'Failed to send AI reply')
    throw err
  }

  // ── UPDATE CONVERSATION METADATA ────────────────────────────

  await adminDb`
    UPDATE conversations
    SET last_ai_model = ${aiModel},
        updated_at    = NOW()
    WHERE id = ${conversationId}
  `

  // ── ANALYTICS EVENTS ────────────────────────────────────────

  const now = new Date().toISOString()
  void Promise.all([
    analyticsQueue.add('analytics', {
      clientId, eventType: 'ai_turn', quantity: 1,
      referenceId: conversationId, occurredAt: now,
    }, { removeOnComplete: true }),
    // Use result.inputTokens + result.outputTokens for token count
    analyticsQueue.add('analytics', {
      clientId, eventType: 'ai_tokens',
      quantity: inputTokens + outputTokens,
      referenceId: conversationId, occurredAt: now,
    }, { removeOnComplete: true }),
  ]).catch((err: unknown) => log.warn({ err }, 'Analytics enqueue failed'))

  log.debug({ conversationId, aiModel, taskType }, 'AI response sent')
}

export function startAIWorker(): Worker<AIConversationJob> {
  const worker = new Worker<AIConversationJob>(QUEUE.ai, processAI, {
    connection:  { url: config.redis.url },
    concurrency: 5,
  })

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, conversationId: job?.data.conversationId, err },
      'AI job failed',
    )
  })

  log.info('AI conversation worker started')
  return worker
}
