// ── PROMETHEUS METRICS REGISTRY ───────────────────────────────
//
// Single registry for the entire main process. Child processes (session
// workers) cannot write here directly — they publish to Redis and the
// queue-depth poller reads those values into gauges.
//
// Import individual metric objects (not the registry) from this module.

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client'

export const registry = new Registry()

// Node.js default metrics (heap, event loop lag, GC, file descriptors, etc.)
collectDefaultMetrics({ register: registry, prefix: 'era_nodejs_' })

// ── MESSAGE METRICS ───────────────────────────────────────────

export const messagesQueuedTotal = new Counter({
  name:    'era_messages_queued_total',
  help:    'Total outbound messages accepted and enqueued',
  labelNames: ['client_id'],
  registers: [registry],
})

export const messagesInboundTotal = new Counter({
  name:    'era_messages_inbound_total',
  help:    'Total inbound WhatsApp messages received',
  labelNames: ['session_id'],
  registers: [registry],
})

export const messagesPlanRejectedTotal = new Counter({
  name:    'era_messages_plan_rejected_total',
  help:    'Outbound messages rejected because plan limit was hit',
  labelNames: ['client_id', 'limit_type'],
  registers: [registry],
})

// ── WEBHOOK METRICS ───────────────────────────────────────────

export const webhookDeliveriesTotal = new Counter({
  name:    'era_webhook_deliveries_total',
  help:    'Webhook delivery attempts',
  labelNames: ['status'],   // 'delivered' | 'failed' | 'dead_lettered'
  registers: [registry],
})

// ── AI METRICS ────────────────────────────────────────────────

export const aiResponseDurationSeconds = new Histogram({
  name:    'era_ai_response_duration_seconds',
  help:    'Time from AI job start to provider response received',
  labelNames: ['provider_id', 'task_type'],
  buckets: [0.2, 0.5, 1, 2, 5, 10, 20, 30],
  registers: [registry],
})

export const aiEscalationsTotal = new Counter({
  name:    'era_ai_escalations_total',
  help:    'Conversations escalated to human by the AI layer',
  labelNames: ['client_id'],
  registers: [registry],
})

// ── SESSION METRICS ───────────────────────────────────────────

export const activeSessions = new Gauge({
  name:    'era_active_sessions',
  help:    'Number of WhatsApp session workers currently running',
  registers: [registry],
})

export const sessionBansTotal = new Counter({
  name:    'era_session_bans_total',
  help:    'Total sessions permanently banned by WhatsApp',
  registers: [registry],
})

// ── QUEUE DEPTH METRICS ───────────────────────────────────────
//
// Updated periodically by the queue depth poller in index.ts.

export const queueDepth = new Gauge({
  name:    'era_queue_depth',
  help:    'Current number of waiting jobs in a BullMQ queue',
  labelNames: ['queue'],
  registers: [registry],
})
