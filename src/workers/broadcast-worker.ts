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
import { logEvent } from '../services/events.js'
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

    logEvent({
      eventType: 'message_failed',
      severity:  'critical',
      detail:    `Broadcast message could not be queued for ${to}: ${errorMsg}`,
      clientId,
      sessionId,
      metadata:  { broadcastId, recipientId, to, error: errorMsg },
    }).catch((e: unknown) => log.error({ e }, 'broadcast queue-failure event write failed'))
    // Don't re-throw — one failed recipient should not block the rest
  }

  // Check if broadcast is complete (all recipients processed)
  type CountRow = { pending: string; name: string; total_sent: string; total_failed: string }
  const counts = (await adminDb`
    SELECT
      COUNT(*) FILTER (WHERE br.status = 'pending')::text AS pending,
      wb.name,
      wb.total_sent::text,
      wb.total_failed::text
    FROM broadcast_recipients br
    JOIN whatsapp_broadcasts wb ON wb.id = br.broadcast_id
    WHERE br.broadcast_id = ${broadcastId}
    GROUP BY wb.name, wb.total_sent, wb.total_failed
  `) as unknown as CountRow[]

  if (parseInt(counts[0]?.pending ?? '1', 10) === 0) {
    await adminDb`
      UPDATE whatsapp_broadcasts
      SET status = 'sent', completed_at = NOW(), updated_at = NOW()
      WHERE id = ${broadcastId} AND status = 'sending'
    `
    log.info({ broadcastId }, 'Broadcast completed')

    const sent   = parseInt(counts[0]?.total_sent   ?? '0', 10)
    const failed = parseInt(counts[0]?.total_failed ?? '0', 10)
    const name   = counts[0]?.name ?? 'Broadcast'
    logEvent({
      eventType: 'broadcast_completed',
      severity:  failed > 0 ? 'warning' : 'info',
      detail:    `Broadcast "${name}" completed: ${sent} queued, ${failed} failed`,
      clientId,
      sessionId,
      metadata:  { broadcastId, totalSent: sent, totalFailed: failed },
    }).catch((e: unknown) => log.error({ e }, 'broadcast_completed event write failed'))
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
