// ── WEBHOOK DELIVERY WORKER ───────────────────────────────────
//
// Delivers webhook payloads to client-registered endpoints.
// Signs each payload with HMAC-SHA256 using the endpoint's secret.
// BullMQ handles retries (up to 10 attempts, exponential backoff).
// On exhausted retries, marks the delivery as 'dead_lettered'.

import { createHmac } from 'node:crypto'
import { Worker } from 'bullmq'
import type { Job } from 'bullmq'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { QUEUE } from '../queues/definitions.js'
import type { WebhookDeliveryJob } from '../queues/definitions.js'

const log = logger.child({ component: 'webhook-worker' })

type DeliveryRow = {
  id: string
  endpoint_id: string
  client_id: string
  event_type: string
  payload: Record<string, unknown>
  attempts: number
}

type EndpointRow = {
  url: string
  secret: string
  status: string
}

async function processWebhook(job: Job<WebhookDeliveryJob>): Promise<void> {
  const { deliveryId } = job.data

  // Load delivery and endpoint
  const deliveries = (await adminDb`
    SELECT wd.id, wd.endpoint_id, wd.client_id, wd.event_type, wd.payload, wd.attempts
    FROM   webhook_deliveries wd
    WHERE  wd.id = ${deliveryId}
      AND  wd.status NOT IN ('delivered', 'dead_lettered')
  `) as unknown as DeliveryRow[]

  const delivery = deliveries[0]
  if (!delivery) return // Already delivered or dead-lettered by a previous attempt

  const endpoints = (await adminDb`
    SELECT url, secret, status FROM webhook_endpoints WHERE id = ${delivery.endpoint_id}
  `) as unknown as EndpointRow[]

  const endpoint = endpoints[0]
  if (!endpoint || endpoint.status !== 'active') {
    await adminDb`
      UPDATE webhook_deliveries SET status = 'dead_lettered' WHERE id = ${deliveryId}
    `
    return
  }

  const body = JSON.stringify(delivery.payload)
  const signature = createHmac('sha256', endpoint.secret).update(body).digest('hex')
  const now = Math.floor(Date.now() / 1000)

  let responseStatus: number | null = null
  let responseBody: string | null = null
  let success = false

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-ERA-Signature':   `sha256=${signature}`,
        'X-ERA-Event':       delivery.event_type,
        'X-ERA-Delivery-ID': deliveryId,
        'X-ERA-Timestamp':   String(now),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    responseStatus = response.status
    responseBody = (await response.text()).slice(0, 512) // Cap stored response body
    success = response.ok
  } catch (err) {
    log.warn({ deliveryId, err }, 'Webhook HTTP request failed')
  }

  if (success) {
    await adminDb`
      UPDATE webhook_deliveries
      SET status           = 'delivered',
          attempts         = attempts + 1,
          last_attempt_at  = NOW(),
          response_status  = ${responseStatus},
          response_body    = ${responseBody}
      WHERE id = ${deliveryId}
    `
    log.debug({ deliveryId, status: responseStatus }, 'Webhook delivered')
  } else {
    await adminDb`
      UPDATE webhook_deliveries
      SET attempts        = attempts + 1,
          last_attempt_at = NOW(),
          response_status = ${responseStatus},
          response_body   = ${responseBody},
          status          = 'failed'
      WHERE id = ${deliveryId}
    `
    throw new Error(`Webhook delivery failed — HTTP ${responseStatus ?? 'no response'}`)
  }
}

async function onFailed(job: Job<WebhookDeliveryJob> | undefined): Promise<void> {
  if (!job) return
  // BullMQ fires 'failed' after every failed attempt, not just the last one.
  // Only dead-letter when all retry attempts are exhausted.
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return
  const { deliveryId } = job.data
  await adminDb`
    UPDATE webhook_deliveries SET status = 'dead_lettered' WHERE id = ${deliveryId}
  `
  log.warn({ deliveryId }, 'Webhook delivery dead-lettered after all retries')
}

export function startWebhookWorker(): Worker<WebhookDeliveryJob> {
  const worker = new Worker<WebhookDeliveryJob>(QUEUE.webhooks, processWebhook, {
    connection: { url: config.redis.url },
    concurrency: 20,
  })

  worker.on('failed', (job, _err) => void onFailed(job))

  log.info('Webhook delivery worker started')
  return worker
}
