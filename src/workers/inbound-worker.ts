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
import { withClient, adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { getOrProvisionProfileVersion } from '../services/messaging.js'
import { messagesInboundTotal } from '../observability/metrics.js'
import { QUEUE } from '../queues/definitions.js'
import type { InboundMessageJob, WebhookDeliveryJob, AIConversationJob } from '../queues/definitions.js'

const log = logger.child({ component: 'inbound-worker' })

type WebhookEndpointRow = {
  id: string
  url: string
  secret: string
}

type DeliveryRow = { id: string }

type ConvRow = { id: string; total_turns: string }

type TransactionResult = {
  deliveryIds:      string[]
  convId:           string
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

      // Find or create active conversation
      const convRows = (await tx`
        SELECT id, total_turns FROM conversations
        WHERE  contact_id = ${contactId}
          AND  session_id = ${msg.sessionId}
          AND  status     = 'active'
        ORDER BY created_at DESC LIMIT 1
      `) as unknown as ConvRow[]

      let convId: string

      if (convRows[0]) {
        convId = convRows[0].id
      } else {
        const newConv = (await tx`
          INSERT INTO conversations (
            client_id, contact_id, session_id, profile_version_id, status
          ) VALUES (
            ${msg.clientId}, ${contactId}, ${msg.sessionId}, ${profileVersionId},
            'active'
          )
          RETURNING id, total_turns
        `) as unknown as ConvRow[]
        convId = newConv[0]!.id
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

      return { deliveryIds, convId, turnCount, messageInserted }
    })

    const { deliveryIds, convId, turnCount, messageInserted } = txResult

    if (messageInserted) {
      messagesInboundTotal.inc({ session_id: msg.sessionId })
    }

    // ── Opt-out handling (STOP / UNSTOP) ──────────────────────────
    if (messageInserted) {
      const normalised = msg.content.trim().toUpperCase()
      if (normalised === 'STOP' || normalised === 'UNSUBSCRIBE') {
        await adminDb`
          INSERT INTO optout_registry (client_id, phone_number, opted_out, opted_out_at)
          VALUES (${msg.clientId}, ${msg.from}, TRUE, NOW())
          ON CONFLICT (client_id, phone_number)
          DO UPDATE SET opted_out = TRUE, opted_out_at = NOW(), updated_at = NOW()
        `
        log.info({ phone: msg.from, clientId: msg.clientId }, 'Opt-out registered (STOP)')
      } else if (normalised === 'START' || normalised === 'UNSTOP') {
        await adminDb`
          INSERT INTO optout_registry (client_id, phone_number, opted_out, opted_in_at)
          VALUES (${msg.clientId}, ${msg.from}, FALSE, NOW())
          ON CONFLICT (client_id, phone_number)
          DO UPDATE SET opted_out = FALSE, opted_in_at = NOW(), updated_at = NOW()
        `
        log.info({ phone: msg.from, clientId: msg.clientId }, 'Opt-in registered (START)')
      }
    }

    // ── Moderation check ──────────────────────────────────────────
    if (messageInserted) {
      type RuleRow = { keyword: string; action: string }
      const rules = (await adminDb`SELECT keyword, action FROM moderation_rules`) as unknown as RuleRow[]
      const lower = msg.content.toLowerCase()
      const matched = rules.find(r => lower.includes(r.keyword.toLowerCase()))

      if (matched) {
        log.warn({ clientId: msg.clientId, keyword: matched.keyword, action: matched.action }, 'Moderation rule matched')

        // Log the event
        await adminDb`
          INSERT INTO moderation_events (client_id, matched_keyword, action_taken, content)
          VALUES (${msg.clientId}, ${matched.keyword}, ${matched.action}, ${msg.content.slice(0, 500)})
        `

        if (matched.action === 'warn') {
          const updated = (await adminDb`
            UPDATE clients SET warning_count = warning_count + 1, updated_at = NOW()
            WHERE id = ${msg.clientId}
            RETURNING warning_count
          `) as unknown as Array<{ warning_count: number }>

          if ((updated[0]?.warning_count ?? 0) >= 3) {
            await adminDb`
              UPDATE clients SET status = 'suspended', suspended_at = NOW(),
                suspension_reason = 'Auto-suspended: 3 or more moderation violations',
                updated_at = NOW()
              WHERE id = ${msg.clientId}
            `
            log.warn({ clientId: msg.clientId }, 'Client auto-suspended after 3 violations')
          }
        } else if (matched.action === 'suspend') {
          await adminDb`
            UPDATE clients SET status = 'suspended', suspended_at = NOW(),
              suspension_reason = ${`Auto-suspended: matched keyword "${matched.keyword}"`},
              updated_at = NOW()
            WHERE id = ${msg.clientId}
          `
          log.warn({ clientId: msg.clientId, keyword: matched.keyword }, 'Client auto-suspended immediately')
        }
      }
    }

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

    // Enqueue AI job when the message is new and the client has AI reply turned on.
    if (messageInserted) {
      type ModRow = { ai_reply: boolean }
      const modRows = (await adminDb`
        SELECT ai_reply FROM module_config WHERE client_id = ${msg.clientId}
      `) as unknown as ModRow[]
      const aiReplyEnabled = modRows[0]?.ai_reply ?? false

      if (aiReplyEnabled) {
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
