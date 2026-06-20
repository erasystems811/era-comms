// ── INBOUND MESSAGE WORKER ────────────────────────────────────
//
// Processes inbound WhatsApp messages from the `inbound` BullMQ queue.
// For each message:
//   1. Find or create the contact
//   2. Find or create the conversation (lazy-provisions profile if needed)
//   3. Insert the message record (idempotent — waMessageId as key)
//   4. Update conversation turn count
//   5. Insert webhook_delivery records for subscribed endpoints
// All DB work is atomic (single withClient transaction).
// Webhook HTTP dispatch is queued AFTER the transaction commits.

import { Worker, Queue } from 'bullmq'
import { withClient } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { getOrProvisionProfileVersion } from '../services/messaging.js'
import { QUEUE } from '../queues/definitions.js'
import type { InboundMessageJob, WebhookDeliveryJob, AIConversationJob } from '../queues/definitions.js'

const log = logger.child({ component: 'inbound-worker' })

type WebhookEndpointRow = {
  id: string
  url: string
  secret: string
}

type DeliveryRow = { id: string }

type ConvRow = { id: string; ai_active: boolean; total_turns: string }

type TransactionResult = {
  deliveryIds:      string[]
  convId:           string
  aiActive:         boolean
  turnCount:        number
  messageInserted:  boolean
}

export function startInboundWorker(): Worker<InboundMessageJob> {
  // Shared queue instances — one Redis connection each, reused across all
  // concurrent processor invocations.
  const webhookQueue = new Queue<WebhookDeliveryJob>(QUEUE.webhooks, {
    connection: { url: config.redis.url },
  })
  const aiQueue = new Queue<AIConversationJob>(QUEUE.ai, {
    connection: { url: config.redis.url },
  })

  async function processInbound(job: { data: InboundMessageJob }): Promise<void> {
    const msg = job.data
    log.debug({ from: msg.from, sessionId: msg.sessionId }, 'Processing inbound message')

    const profileVersionId = await getOrProvisionProfileVersion(msg.clientId)

    const txResult = await withClient(msg.clientId, async (tx): Promise<TransactionResult> => {
      // Find or create contact
      const contactRows = (await tx`
        INSERT INTO contacts (client_id, phone_number)
        VALUES (${msg.clientId}, ${msg.from})
        ON CONFLICT (client_id, phone_number) DO UPDATE
          SET last_contacted_at = NOW(),
              updated_at        = NOW()
        RETURNING id
      `) as unknown as Array<{ id: string }>

      const contactId: string = contactRows[0]!.id

      // Find or create active conversation — include ai_active for AI job decision
      const convRows = (await tx`
        SELECT id, ai_active, total_turns FROM conversations
        WHERE  contact_id = ${contactId}
          AND  session_id = ${msg.sessionId}
          AND  status     = 'active'
        ORDER BY created_at DESC LIMIT 1
      `) as unknown as ConvRow[]

      let convId:   string
      let aiActive: boolean

      if (convRows[0]) {
        convId   = convRows[0].id
        aiActive = convRows[0].ai_active
      } else {
        const newConv = (await tx`
          INSERT INTO conversations (
            client_id, contact_id, session_id, profile_version_id, status, ai_active
          ) VALUES (
            ${msg.clientId}, ${contactId}, ${msg.sessionId}, ${profileVersionId},
            'active', TRUE
          )
          RETURNING id, ai_active, total_turns
        `) as unknown as ConvRow[]
        convId   = newConv[0]!.id
        aiActive = newConv[0]!.ai_active
      }

      // Insert message — RETURNING id lets us detect ON CONFLICT DO NOTHING
      // (empty result = duplicate; skip AI and webhooks for replays)
      const msgRows = (await tx`
        INSERT INTO messages (
          conversation_id, client_id, session_id,
          direction, content, content_type, media_url,
          idempotency_key, wa_message_id, status
        ) VALUES (
          ${convId}, ${msg.clientId}, ${msg.sessionId},
          'inbound', ${msg.content}, ${msg.contentType}, ${msg.mediaUrl ?? null},
          ${msg.waMessageId}, ${msg.waMessageId}, 'delivered'
        )
        ON CONFLICT (client_id, idempotency_key) DO NOTHING
        RETURNING id
      `) as unknown as Array<{ id: string }>

      const messageInserted = msgRows.length > 0

      let turnCount = 0
      if (messageInserted) {
        const updRows = (await tx`
          UPDATE conversations
          SET total_turns = total_turns + 1,
              updated_at  = NOW()
          WHERE id = ${convId}
          RETURNING total_turns
        `) as unknown as Array<{ total_turns: string }>
        turnCount = parseInt(updRows[0]?.total_turns ?? '1', 10)
      }

      // Find subscribed webhook endpoints for 'message.inbound'
      const endpoints = (await tx`
        SELECT id, url, secret FROM webhook_endpoints
        WHERE client_id = ${msg.clientId}
          AND status    = 'active'
          AND 'message.inbound' = ANY(events)
      `) as unknown as WebhookEndpointRow[]

      const deliveryIds: string[] = []

      if (messageInserted && endpoints.length > 0) {
        const payload = {
          event: 'message.inbound',
          data: {
            sessionId:      msg.sessionId,
            from:           msg.from,
            content:        msg.content,
            contentType:    msg.contentType,
            mediaUrl:       msg.mediaUrl ?? null,
            waMessageId:    msg.waMessageId,
            conversationId: convId,
            timestamp:      msg.timestamp,
          },
        }

        for (const ep of endpoints) {
          const dRows = (await tx`
            INSERT INTO webhook_deliveries (endpoint_id, client_id, event_type, payload)
            VALUES (${ep.id}, ${msg.clientId}, 'message.inbound', ${JSON.stringify(payload)}::jsonb)
            RETURNING id
          `) as unknown as DeliveryRow[]
          if (dRows[0]) deliveryIds.push(dRows[0].id)
        }
      }

      return { deliveryIds, convId, aiActive, turnCount, messageInserted }
    })

    const { deliveryIds, convId, aiActive, turnCount, messageInserted } = txResult

    // Enqueue webhook jobs after transaction commits
    if (deliveryIds.length > 0) {
      await Promise.all(
        deliveryIds.map((deliveryId) =>
          webhookQueue.add(
            'webhook',
            { deliveryId },
            { attempts: 10, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true },
          ),
        ),
      )
    }

    // Enqueue AI job when the message was new and the conversation has AI active.
    // The AI worker decides whether to respond (checks ai_active, escalation status, etc.).
    if (messageInserted && aiActive) {
      const contextTokens = Math.ceil(msg.content.length / 4)
      await aiQueue.add(
        'ai',
        {
          conversationId: convId,
          clientId:       msg.clientId,
          messageId:      msg.waMessageId,
          turnCount,
          contextTokens,
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true },
      )
    }
  }

  const worker = new Worker<InboundMessageJob>(QUEUE.inbound, processInbound, {
    connection: { url: config.redis.url },
    concurrency: 10,
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, from: job?.data.from, err }, 'Inbound message processing failed')
  })

  log.info('Inbound message worker started')
  return worker
}
