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
import type { InboundMessageJob, WebhookDeliveryJob } from '../queues/definitions.js'

const log = logger.child({ component: 'inbound-worker' })

type WebhookEndpointRow = {
  id: string
  url: string
  secret: string
}

type DeliveryRow = { id: string }

export function startInboundWorker(): Worker<InboundMessageJob> {
  // One Queue instance shared across all concurrent processor invocations.
  // Creating it per-job would open a new Redis connection for every inbound message.
  const webhookQueue = new Queue<WebhookDeliveryJob>(QUEUE.webhooks, {
    connection: { url: config.redis.url },
  })

  async function processInbound(job: { data: InboundMessageJob }): Promise<void> {
    const msg = job.data
    log.debug({ from: msg.from, sessionId: msg.sessionId }, 'Processing inbound message')

    const profileVersionId = await getOrProvisionProfileVersion(msg.clientId)

    const deliveryIds = await withClient(msg.clientId, async (tx) => {
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

      // Find or create active conversation for this contact + session
      const convRows = (await tx`
        SELECT id FROM conversations
        WHERE  contact_id = ${contactId}
          AND  session_id = ${msg.sessionId}
          AND  status     = 'active'
        ORDER BY created_at DESC LIMIT 1
      `) as unknown as Array<{ id: string }>

      let convId: string
      if (convRows[0]) {
        convId = convRows[0].id
      } else {
        const newConv = (await tx`
          INSERT INTO conversations (
            client_id, contact_id, session_id, profile_version_id, status, ai_active
          ) VALUES (
            ${msg.clientId}, ${contactId}, ${msg.sessionId}, ${profileVersionId},
            'active', TRUE
          )
          RETURNING id
        `) as unknown as Array<{ id: string }>
        convId = newConv[0]!.id
      }

      // Insert message — idempotent on (client_id, idempotency_key)
      // Use the WhatsApp message ID as the idempotency key for inbound messages.
      await tx`
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
      `

      // Update conversation turn count
      await tx`
        UPDATE conversations
        SET total_turns = total_turns + 1,
            updated_at  = NOW()
        WHERE id = ${convId}
      `

      // Find subscribed webhook endpoints for 'message.inbound'
      const endpoints = (await tx`
        SELECT id, url, secret FROM webhook_endpoints
        WHERE client_id = ${msg.clientId}
          AND status    = 'active'
          AND 'message.inbound' = ANY(events)
      `) as unknown as WebhookEndpointRow[]

      if (endpoints.length === 0) return []

      // Build the webhook payload once (same for all endpoints)
      const payload = {
        event: 'message.inbound',
        data: {
          sessionId:     msg.sessionId,
          from:          msg.from,
          content:       msg.content,
          contentType:   msg.contentType,
          mediaUrl:      msg.mediaUrl ?? null,
          waMessageId:   msg.waMessageId,
          conversationId: convId,
          timestamp:     msg.timestamp,
        },
      }

      // Insert delivery records and collect their IDs
      const ids: string[] = []
      for (const ep of endpoints) {
        const dRows = (await tx`
          INSERT INTO webhook_deliveries (endpoint_id, client_id, event_type, payload)
          VALUES (${ep.id}, ${msg.clientId}, 'message.inbound', ${JSON.stringify(payload)}::jsonb)
          RETURNING id
        `) as unknown as DeliveryRow[]

        if (dRows[0]) ids.push(dRows[0].id)
      }

      return ids
    })

    // Enqueue webhook jobs after transaction commits — guarantees records exist
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
