// ── ANALYTICS WORKER ──────────────────────────────────────────
//
// Drains the `analytics` BullMQ queue into usage_events (TimescaleDB
// hypertable). Fires come from the AI worker (ai_turn, ai_tokens) and
// any other main-process component that emits usage events.
//
// The session worker writes message_sent events directly via adminDb
// (it's a child process; no queue needed there).
//
// Concurrency 20 — inserts are append-only and hypertables are fast.

import { Worker } from 'bullmq'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { QUEUE } from '../queues/definitions.js'
import type { AnalyticsJob } from '../queues/definitions.js'

const log = logger.child({ component: 'analytics-worker' })

const VALID_EVENT_TYPES = new Set([
  'message_sent',
  'message_received',
  'ai_turn',
  'ai_tokens',
  'voice_call_initiated',
  'voice_call_second',
  'webhook_delivered',
])

async function processAnalytics(job: { data: AnalyticsJob }): Promise<void> {
  const { clientId, eventType, quantity, referenceId, occurredAt } = job.data

  if (!VALID_EVENT_TYPES.has(eventType)) {
    log.warn({ eventType }, 'Unknown analytics event type — dropping')
    return
  }

  await adminDb`
    INSERT INTO usage_events (client_id, event_type, quantity, reference_id, occurred_at)
    VALUES (
      ${clientId},
      ${eventType},
      ${quantity},
      ${referenceId ?? null},
      ${occurredAt}
    )
  `
}

export function startAnalyticsWorker(): Worker<AnalyticsJob> {
  const worker = new Worker<AnalyticsJob>(QUEUE.analytics, processAnalytics, {
    connection:  { url: config.redis.url },
    concurrency: 20,
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, eventType: job?.data.eventType, err }, 'Analytics job failed')
  })

  log.info('Analytics worker started')
  return worker
}
