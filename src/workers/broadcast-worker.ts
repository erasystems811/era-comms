// ── BROADCAST WORKER ──────────────────────────────────────────
//
// Processes BroadcastRecipientJob from the `broadcast` BullMQ queue.
// One job per recipient. Sends the message with jitter between sends
// to avoid WhatsApp detecting bulk sending patterns.

import { Worker } from 'bullmq'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { sendMessage } from '../services/messaging.js'
import { QUEUE } from '../queues/definitions.js'
import type { BroadcastRecipientJob } from '../queues/definitions.js'

const log = logger.child({ component: 'broadcast-worker' })

async function processRecipient(job: { data: BroadcastRecipientJob }): Promise<void> {
  const { broadcastId, recipientId, clientId, sessionId, to, content, contentType } = job.data

  try {
    const result = await sendMessage({
      clientId,
      sessionId,
      to,
      content,
      contentType: contentType as 'text',
      idempotencyKey: `broadcast_${broadcastId}_${recipientId}`,
    })

    await adminDb`
      UPDATE broadcast_recipients
      SET status     = 'sent',
          message_id = ${result.messageId}::uuid,
          sent_at    = NOW()
      WHERE id = ${recipientId}
    `

    await adminDb`
      UPDATE whatsapp_broadcasts
      SET total_sent = total_sent + 1, updated_at = NOW()
      WHERE id = ${broadcastId}
    `
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.warn({ broadcastId, recipientId, to, err }, 'Broadcast recipient send failed')

    await adminDb`
      UPDATE broadcast_recipients
      SET status = 'failed', error = ${errorMsg}
      WHERE id = ${recipientId}
    `

    await adminDb`
      UPDATE whatsapp_broadcasts
      SET total_failed = total_failed + 1, updated_at = NOW()
      WHERE id = ${broadcastId}
    `
    // Don't re-throw — one failed recipient should not block the rest
  }

  // Check if broadcast is complete (all recipients processed)
  type CountRow = { pending: string }
  const counts = (await adminDb`
    SELECT COUNT(*) FILTER (WHERE status = 'pending')::text AS pending
    FROM   broadcast_recipients
    WHERE  broadcast_id = ${broadcastId}
  `) as unknown as CountRow[]

  if (parseInt(counts[0]?.pending ?? '1', 10) === 0) {
    await adminDb`
      UPDATE whatsapp_broadcasts
      SET status = 'sent', completed_at = NOW(), updated_at = NOW()
      WHERE id = ${broadcastId} AND status = 'sending'
    `
    log.info({ broadcastId }, 'Broadcast completed')
  }
}

export function startBroadcastWorker(): Worker<BroadcastRecipientJob> {
  const worker = new Worker<BroadcastRecipientJob>(QUEUE.broadcast, processRecipient, {
    connection:  { url: config.redis.url },
    concurrency: 3, // 3 sends in parallel max — keeps it human-paced
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, recipientId: job?.data.recipientId, err }, 'Broadcast job failed')
  })

  log.info('Broadcast worker started')
  return worker
}
