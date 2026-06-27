// ── AI CONVERSATION WORKER ────────────────────────────────────
//
// Processes AIConversationJob from the `ai` BullMQ queue.
// Only triggered when the business has ai_reply = TRUE in module_config.
//
// Per-job flow:
//   1. Load ai_reply_profile for the client
//   2. Skip if not found or ai_reply toggle is off
//   3. Skip if conversation is not active (escalated / closed)
//   4. Check escalation triggers in latest inbound message
//   5. Build message history + system prompt
//   6. Call AI provider (GPT-4o-mini or GPT-4o)
//   7. Send reply via sendMessage()
//   8. Enqueue analytics event

import { Worker, Queue } from 'bullmq'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { sendMessage } from '../services/messaging.js'
import { aiRouter } from '../ai/router.js'
import { taskClassifier, estimateSentiment } from '../ai/classifier.js'
import type { ChatMessage } from '../interfaces/ai.js'
import { aiResponseDurationSeconds, aiEscalationsTotal } from '../observability/metrics.js'
import { QUEUE } from '../queues/definitions.js'
import type { AIConversationJob, WebhookDeliveryJob, AnalyticsJob } from '../queues/definitions.js'

const log = logger.child({ component: 'ai-worker' })

type WebhookEndpointRow = { id: string }
type DeliveryRow        = { id: string }

type AIProfileRow = {
  persona:             string
  tone:                string
  system_prompt:       string
  permitted_topics:    string[]
  prohibited_topics:   string[]
  escalation_triggers: string[]
  max_tokens:          number
  temperature:         number
}

type ConversationRow = {
  status:     string
  session_id: string
}

type MessageRow = {
  direction: 'inbound' | 'outbound'
  content:   string
}

type ContactRow = { phone_number: string }

const webhookQueue   = new Queue<WebhookDeliveryJob>(QUEUE.webhooks,   { connection: { url: config.redis.url } })
const analyticsQueue = new Queue<AnalyticsJob>(QUEUE.analytics,         { connection: { url: config.redis.url } })

async function escalateConversation(conversationId: string, clientId: string, reason: string): Promise<void> {
  await adminDb`
    UPDATE conversations
    SET status            = 'escalated',
        escalated_at      = NOW(),
        escalation_reason = ${reason},
        updated_at        = NOW()
    WHERE id = ${conversationId}
  `

  const endpoints = (await adminDb`
    SELECT id FROM webhook_endpoints
    WHERE client_id = ${clientId}
      AND status    = 'active'
      AND 'conversation.escalated' = ANY(events)
  `) as unknown as WebhookEndpointRow[]

  if (endpoints.length === 0) return

  const payload = JSON.stringify({ event: 'conversation.escalated', data: { conversationId, reason } })

  await Promise.all(
    endpoints.map(async (ep) => {
      const dRows = (await adminDb`
        INSERT INTO webhook_deliveries (endpoint_id, client_id, event_type, payload)
        VALUES (${ep.id}, ${clientId}, 'conversation.escalated', ${payload}::jsonb)
        RETURNING id
      `) as unknown as DeliveryRow[]

      const deliveryId = dRows[0]?.id
      if (!deliveryId) return

      await webhookQueue.add('webhook', { deliveryId }, {
        attempts: 10, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true,
      })
    }),
  )
}

function buildSystemPrompt(profile: AIProfileRow): string {
  const parts = [
    `You are ${profile.persona}. Your communication style is ${profile.tone}.`,
    profile.system_prompt,
  ]
  if (profile.permitted_topics.length > 0) {
    parts.push(`You may only discuss: ${profile.permitted_topics.join(', ')}.`)
  }
  if (profile.prohibited_topics.length > 0) {
    parts.push(`Never discuss or reference: ${profile.prohibited_topics.join(', ')}.`)
  }
  if (profile.escalation_triggers.length > 0) {
    parts.push(
      `If the contact mentions any of the following, say you are connecting them with a team member and stop responding: ${profile.escalation_triggers.join(', ')}.`,
    )
  }
  parts.push('Keep responses concise and conversational. This is WhatsApp — avoid long paragraphs.')
  return parts.join('\n\n')
}

async function processAI(job: { data: AIConversationJob }): Promise<void> {
  const { conversationId, clientId, messageId } = job.data

  log.debug({ conversationId, messageId }, 'Processing AI response')

  // Load AI profile for this client
  const profileRows = (await adminDb`
    SELECT persona, tone, system_prompt, permitted_topics, prohibited_topics,
           escalation_triggers, max_tokens, temperature
    FROM   ai_reply_profiles
    WHERE  client_id = ${clientId}
  `) as unknown as AIProfileRow[]

  const profile = profileRows[0]
  if (!profile) {
    log.warn({ conversationId, clientId }, 'No AI reply profile found — skipping (configure AI in business settings)')
    return
  }

  // Guard: check the toggle is still on (it may have been disabled after this job was enqueued)
  type ModRow = { ai_reply: boolean }
  const modRows = (await adminDb`
    SELECT ai_reply FROM module_config WHERE client_id = ${clientId}
  `) as unknown as ModRow[]
  if (!(modRows[0]?.ai_reply ?? false)) {
    log.debug({ conversationId, clientId }, 'AI reply is off — skipping')
    return
  }

  // Load conversation state
  const convRows = (await adminDb`
    SELECT status, session_id FROM conversations WHERE id = ${conversationId}
  `) as unknown as ConversationRow[]

  const conv = convRows[0]
  if (!conv || conv.status !== 'active') {
    log.debug({ conversationId, status: conv?.status }, 'Conversation not active — skipping AI reply')
    return
  }

  // Load recent message history
  const msgRows = (await adminDb`
    SELECT direction, content FROM messages
    WHERE  conversation_id = ${conversationId} AND status != 'failed'
    ORDER BY created_at DESC LIMIT 20
  `) as unknown as MessageRow[]

  const messages = [...msgRows].reverse()

  // Find latest inbound content
  let latestInbound = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.direction === 'inbound') { latestInbound = messages[i]?.content ?? ''; break }
  }

  // Escalation check
  const hasEscalation = profile.escalation_triggers.some(t =>
    latestInbound.toLowerCase().includes(t.toLowerCase()),
  )

  if (hasEscalation) {
    log.info({ conversationId }, 'Escalation trigger detected')
    aiEscalationsTotal.inc({ client_id: clientId })
    await escalateConversation(conversationId, clientId, `Escalation trigger in: "${latestInbound.slice(0, 100)}"`)
    return
  }

  // Build chat messages
  const chatMessages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(profile) }]
  for (const m of messages) {
    chatMessages.push({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    })
  }

  // Route to provider
  const sentimentScore = estimateSentiment(latestInbound)
  const turnCount = messages.length
  const contextTokens = Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4)
  const taskType = taskClassifier.classify({
    turnCount, contextTokens,
    hasEscalationKeywords: hasEscalation,
    hasFlaggedTopics: profile.prohibited_topics.some(t => latestInbound.toLowerCase().includes(t.toLowerCase())),
    sentimentScore,
    priorEscalations: 0,
  })
  const provider = aiRouter.forTask(taskType)

  // Generate response
  const aiStart = Date.now()
  let aiResponse = ''
  let aiModel = ''
  let inputTokens = 0
  let outputTokens = 0

  try {
    const result = await provider.complete(chatMessages, {
      maxTokens:   profile.max_tokens,
      temperature: Number(profile.temperature),
    })
    aiResponseDurationSeconds.observe(
      { provider_id: provider.providerId, task_type: taskType },
      (Date.now() - aiStart) / 1000,
    )
    aiResponse   = result.content.trim()
    aiModel      = result.model
    inputTokens  = result.inputTokens
    outputTokens = result.outputTokens
  } catch (err) {
    log.error({ conversationId, err }, 'AI provider call failed')
    throw err
  }

  if (!aiResponse) {
    log.warn({ conversationId }, 'AI returned empty response — skipping')
    return
  }

  // Get contact phone number
  const contactRows = (await adminDb`
    SELECT c.phone_number FROM contacts c
    JOIN   conversations conv ON conv.contact_id = c.id
    WHERE  conv.id = ${conversationId}
  `) as unknown as ContactRow[]

  const to = contactRows[0]?.phone_number
  if (!to) { log.warn({ conversationId }, 'No contact phone — cannot send'); return }

  // Send reply
  try {
    await sendMessage({
      clientId, sessionId: conv.session_id, to,
      content: aiResponse, contentType: 'text',
      conversationId, aiGenerated: true,
    })
  } catch (err) {
    log.error({ conversationId, err }, 'Failed to send AI reply')
    throw err
  }

  await adminDb`
    UPDATE conversations SET last_ai_model = ${aiModel}, updated_at = NOW() WHERE id = ${conversationId}
  `

  const now = new Date().toISOString()
  void Promise.all([
    analyticsQueue.add('analytics', { clientId, eventType: 'ai_turn', quantity: 1, referenceId: conversationId, occurredAt: now }, { removeOnComplete: true }),
    analyticsQueue.add('analytics', { clientId, eventType: 'ai_tokens', quantity: inputTokens + outputTokens, referenceId: conversationId, occurredAt: now }, { removeOnComplete: true }),
  ]).catch((err: unknown) => log.warn({ err }, 'Analytics enqueue failed'))

  log.debug({ conversationId, aiModel, taskType }, 'AI response sent')
}

export function startAIWorker(): Worker<AIConversationJob> {
  const worker = new Worker<AIConversationJob>(QUEUE.ai, processAI, {
    connection:  { url: config.redis.url },
    concurrency: 5,
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, conversationId: job?.data.conversationId, err }, 'AI job failed')
  })

  log.info('AI conversation worker started')
  return worker
}
