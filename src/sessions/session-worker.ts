// ── SESSION WORKER — CHILD PROCESS ENTRY POINT ───────────────
//
// Each WhatsApp session runs as its own isolated process.
// Spawned by the supervisor with the session ID as argv[2].
// Owns one WhatsApp connection and one outbound BullMQ worker.
// All communication with the rest of the system is via Redis.

import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { adminDb } from '../db/client.js'
import { redis as generalRedis } from '../db/redis.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { BaileysSession } from './baileys-session.js'
import { calculateJitter } from '../anti-detection/jitter.js'
import { checkWarmup, incrementDailyCount } from '../anti-detection/warmup.js'
import { varyMessage } from '../anti-detection/variation.js'
import { updateRiskScore } from '../anti-detection/risk.js'
import { recordMessageSent } from '../services/plan.js'
import { logEvent } from '../services/events.js'
import {
  QUEUE,
  KEY,
  CHANNEL,
  HEARTBEAT_TTL_SECONDS,
  HEARTBEAT_INTERVAL_MS,
} from '../queues/definitions.js'

import type {
  OutboundMessageJob,
  InboundMessageJob,
  SessionStatusUpdate,
  SessionCommand,
} from '../queues/definitions.js'
import type { InboundMessage } from '../interfaces/session.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// argv[2] is string | undefined due to noUncheckedIndexedAccess.
// Guard early and re-declare as string so TypeScript propagates the
// narrowing correctly through closures.
const rawArg = process.argv[2]
if (!rawArg) {
  console.error('Session worker requires a session ID as the first argument')
  process.exit(1)
}
const SESSION_ID: string = rawArg

const workerLogger = logger.child({ sessionId: SESSION_ID, component: 'session-worker' })

// postgres.js tagged template literals have complex return types that
// TypeScript strict mode struggles to narrow. Use this thin wrapper
// so all typed queries go through one cast site.
async function q<T extends Record<string, unknown>>(
  query: ReturnType<typeof adminDb>,
): Promise<T[]> {
  return (await query) as unknown as T[]
}

// ── BOOTSTRAP ─────────────────────────────────────────────────

async function start(): Promise<void> {
  workerLogger.info('Session worker starting')

  type SessionRow = { phone_number: string; status: string; client_id: string }
  const rows = await q<SessionRow>(
    adminDb`SELECT phone_number, status, client_id FROM whatsapp_sessions WHERE id = ${SESSION_ID}`,
  )

  const row = rows[0]
  if (!row) {
    workerLogger.error('Session not found in database')
    process.exit(1)
  }

  if (row.status === 'banned') {
    workerLogger.warn('Session is banned — exiting worker')
    process.exit(0)
  }

  // Capture as local strings — avoids repeated index-access undefined checks below
  const phoneNumber: string = row.phone_number
  const clientId: string = row.client_id

  const session = new BaileysSession(SESSION_ID, phoneNumber)

  // ── INBOUND MESSAGE HANDLER ──────────────────────────────────

  const inboundQueue = new Queue<InboundMessageJob>(QUEUE.inbound, {
    connection: { url: config.redis.url },
  })

  session.onMessage(async (msg: InboundMessage) => {
    workerLogger.debug({ from: msg.from, waMessageId: msg.waMessageId }, 'Inbound message')

    logEvent({
      eventType: 'message_received',
      severity:  'info',
      detail:    `Message received from ${msg.from}`,
      clientId,
      sessionId: SESSION_ID,
      metadata:  { from: msg.from, waMessageId: msg.waMessageId, contentType: msg.contentType },
    }).catch((err: unknown) => workerLogger.error({ err }, 'message_received event write failed'))

    await inboundQueue.add('inbound', {
      sessionId: SESSION_ID,
      clientId,
      from: msg.from,
      content: msg.content,
      contentType: msg.contentType,
      mediaUrl: msg.mediaUrl,
      waMessageId: msg.waMessageId,
      timestamp: msg.timestamp.toISOString(),
    })
  })

  // ── STATUS PUBLISHER ─────────────────────────────────────────

  const publishStatus = async (
    update: Omit<SessionStatusUpdate, 'sessionId' | 'timestamp'>,
  ): Promise<void> => {
    const payload: SessionStatusUpdate = {
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      ...update,
    }
    await generalRedis.publish(CHANNEL.sessionStatus(SESSION_ID), JSON.stringify(payload))
  }

  // ── CONNECT ───────────────────────────────────────────────────

  // Apply WhatsApp Business profile once the session connects.
  // Runs automatically on first connect and on every reconnect.
  session.onConnected(async () => {
    logEvent({
      eventType: 'session_connected',
      severity:  'info',
      detail:    `Session connected (${phoneNumber})`,
      clientId,
      sessionId: SESSION_ID,
      metadata:  { phoneNumber },
    }).catch((err: unknown) => workerLogger.error({ err }, 'session_connected event write failed'))
    type ProfileRow = { profile_name: string | null; profile_description: string | null; profile_picture_url: string | null }
    const profileRows = await q<ProfileRow>(
      adminDb`SELECT profile_name, profile_description, profile_picture_url FROM whatsapp_sessions WHERE id = ${SESSION_ID}`,
    )
    const p = profileRows[0]
    if (p && (p.profile_name || p.profile_description || p.profile_picture_url)) {
      try {
        await session.applyProfile({
          name: p.profile_name,
          description: p.profile_description,
          pictureUrl: p.profile_picture_url,
        })
        workerLogger.info('WhatsApp Business profile applied')
      } catch (err) {
        workerLogger.warn({ err }, 'Failed to apply WhatsApp Business profile')
      }
    }
  })

  await publishStatus({ status: 'connecting' })
  await session.connect()

  // Publish QR codes to Redis so the API WebSocket can forward them.
  // The generator yields until the session connects or fails — then closes.
  // If WhatsApp never responds (e.g. datacenter IP silently dropped),
  // emit a timeout error after 45 s so the frontend shows a real reason.
  void (async () => {
    let gotEvent = false

    const idleTimeout = setTimeout(async () => {
      if (!gotEvent) {
        workerLogger.warn('No QR from WhatsApp after 45 s — connection may be blocked')
        await generalRedis.publish(
          CHANNEL.sessionQR(SESSION_ID),
          JSON.stringify({
            type: 'error',
            reason:
              'WhatsApp is not responding (45 s timeout). The server IP may be blocked by WhatsApp. Try again — if it keeps failing, the session may need to run outside Railway.',
          }),
        )
      }
    }, 45_000)

    try {
      for await (const event of session.qrStream()) {
        if (!gotEvent) {
          gotEvent = true
          clearTimeout(idleTimeout)
        }
        if (event.type === 'restart') {
          // WhatsApp 515: exit cleanly so the supervisor restarts this worker.
          // The QR WebSocket subscription stays alive and will receive the QR
          // from the new worker instance.
          workerLogger.info('Restarting worker on WhatsApp 515 signal')
          process.exit(0)
        }
        await generalRedis.publish(CHANNEL.sessionQR(SESSION_ID), JSON.stringify(event))
      }
    } catch {
      // Generator closed — session connected or terminated
    } finally {
      clearTimeout(idleTimeout)
    }
  })()

  // ── HEARTBEAT ─────────────────────────────────────────────────

  const heartbeat = setInterval(async () => {
    await generalRedis.setex(KEY.sessionHeartbeat(SESSION_ID), HEARTBEAT_TTL_SECONDS, '1')
    await adminDb`UPDATE whatsapp_sessions SET last_heartbeat_at = NOW() WHERE id = ${SESSION_ID}`
  }, HEARTBEAT_INTERVAL_MS)

  await generalRedis.setex(KEY.sessionHeartbeat(SESSION_ID), HEARTBEAT_TTL_SECONDS, '1')

  // ── OUTBOUND QUEUE WORKER ─────────────────────────────────────
  //
  // concurrency: 1 — one message at a time per session.
  // Simultaneous sends from the same number look automated.

  const outboundWorker = new Worker<OutboundMessageJob>(
    QUEUE.outbound(SESSION_ID),
    async (job) => {
      const messageId:    string  = job.data.messageId
      const to:           string  = job.data.to
      const content:      string  = job.data.content
      const contentType:  string  = job.data.contentType
      const aiGenerated:  boolean = job.data.aiGenerated

      workerLogger.debug({ messageId, to }, 'Processing outbound message')

      // ── 0. CONNECTION CHECK ─────────────────────────────────
      // If not connected, fail immediately so BullMQ retries with backoff.
      // Do not block the worker thread waiting — other sessions need it.
      if (session.getStatus() !== 'connected') {
        throw new Error(`Session not connected (status: ${session.getStatus()}) — will retry`)
      }

      // ── 1. WARMUP CAP CHECK ─────────────────────────────────
      //
      // Resolve the current warmup stage and enforce the daily cap.
      // If the cap is exceeded, mark the message failed without
      // retrying — the cap is deterministic for the rest of the day.

      const warmup = await checkWarmup(SESSION_ID)

      if (!warmup.allowed) {
        workerLogger.warn(
          { messageId, sentToday: warmup.sentToday, cap: warmup.cap },
          'Warmup daily cap reached — message failed',
        )
        await adminDb`UPDATE messages SET status = 'failed' WHERE id = ${messageId}`
        void logEvent({
          eventType: 'message_failed',
          severity:  'warning',
          detail:    `Message blocked — daily warmup cap reached (${warmup.sentToday}/${warmup.cap})`,
          clientId,
          sessionId: SESSION_ID,
          metadata:  { messageId, to, sentToday: warmup.sentToday, cap: warmup.cap },
        })
        return // no throw — BullMQ treats this as success; no retry
      }

      // ── 2. MESSAGE VARIATION ────────────────────────────────
      //
      // Only text messages authored by humans are varied.
      // Falls back to original on any AI error (never blocks delivery).

      let finalContent   = content
      let wasVaried      = false

      if (contentType === 'text') {
        const varied = await varyMessage(content, warmup.stage, aiGenerated)
        finalContent = varied.content
        wasVaried    = varied.wasVaried
      }

      // ── 3. JITTER + COMPOSING ───────────────────────────────
      //
      // Show a "typing…" indicator for a human-realistic duration,
      // then pause before actually sending.

      const jitter = calculateJitter(warmup.stage, finalContent.length)

      try {
        await session.sendComposing(to, jitter.composingMs)
      } catch {
        // Composing is best-effort — proceed without it
      }

      await delay(jitter.delayMs)

      // ── 4. SEND ─────────────────────────────────────────────

      try {
        const result = await session.sendMessage(to, finalContent)

        // Increment warmup counter and plan usage counters after confirmed send
        await incrementDailyCount(SESSION_ID)
        await recordMessageSent(clientId)

        await logEvent({
          eventType: 'message_sent',
          severity:  'info',
          detail:    `Message sent to ${to}`,
          clientId,
          sessionId: SESSION_ID,
          metadata:  { messageId, to, waMessageId: result.waMessageId, wasVaried, warmupStage: warmup.stage },
        }).catch((err: unknown) => workerLogger.error({ err }, 'message_sent event write failed'))

        await adminDb`
          UPDATE messages
          SET wa_message_id    = ${result.waMessageId},
              status           = 'sent',
              sent_at          = NOW(),
              was_varied       = ${wasVaried},
              original_content = ${wasVaried ? content : null},
              warmup_stage     = ${warmup.stage}
          WHERE id = ${messageId}
        `

        // Write usage event directly — session worker is a child process
        // and does not participate in the main-process BullMQ analytics queue.
        void adminDb`
          INSERT INTO usage_events (client_id, event_type, quantity, reference_id, occurred_at)
          VALUES (${clientId}, 'message_sent', 1, ${messageId}::uuid, NOW())
        `.catch((err: unknown) => workerLogger.warn({ err }, 'Usage event write failed'))

        // Risk score update is fire-and-forget — never block delivery
        void updateRiskScore(SESSION_ID).catch((err: unknown) =>
          workerLogger.warn({ err }, 'Risk score update failed'),
        )
      } catch (err) {
        workerLogger.error({ messageId, err }, 'Failed to send message')
        await adminDb`UPDATE messages SET status = 'failed' WHERE id = ${messageId}`
        void logEvent({
          eventType: 'message_failed',
          severity:  'critical',
          detail:    `Failed to send message to ${to}: ${err instanceof Error ? err.message : String(err)}`,
          clientId,
          sessionId: SESSION_ID,
          metadata:  { messageId, to, error: String(err) },
        })
        throw err // re-throw so BullMQ applies retry policy
      }
    },
    {
      connection: { url: config.redis.url },
      concurrency: 1,
      limiter: { max: 10, duration: 60_000 },
    },
  )

  outboundWorker.on('failed', (job, err) => {
    workerLogger.error({ jobId: job?.id, err }, 'Outbound job failed')
  })

  // ── COMMAND SUBSCRIBER ────────────────────────────────────────

  const commandSubscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null })
  await commandSubscriber.subscribe(CHANNEL.sessionCommand(SESSION_ID))

  commandSubscriber.on('message', (_channel: string, message: string) => {
    const cmd = JSON.parse(message) as SessionCommand
    workerLogger.info({ command: cmd.command }, 'Received session command')

    if (cmd.command === 'disconnect') {
      void session.disconnect()
    } else if (cmd.command === 'set_profile') {
      void session.applyProfile({
        name: cmd.name,
        description: cmd.description,
        pictureUrl: cmd.pictureUrl,
      }).catch((err: unknown) => workerLogger.warn({ err }, 'set_profile command failed'))
    } else if (cmd.command === 'request_pairing_code') {
      session.requestPairingCode(cmd.phoneNumber)
        .then((code) => generalRedis.publish(CHANNEL.pairingCodeResult(SESSION_ID), JSON.stringify({ ok: true, code })))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          void generalRedis.publish(CHANNEL.pairingCodeResult(SESSION_ID), JSON.stringify({ ok: false, error: message }))
        })
    }
  })

  // ── STATUS POLLING ────────────────────────────────────────────

  let lastPublishedStatus = session.getStatus()
  const statusPoll = setInterval(async () => {
    const current = session.getStatus()
    if (current !== lastPublishedStatus) {
      lastPublishedStatus = current
      await publishStatus({
        status:
          current === 'connected'    ? 'connected'
          : current === 'banned'     ? 'banned'
          : current === 'connecting' ? 'connecting'
          :                           'disconnected',
      })
      if (current === 'disconnected') {
        logEvent({
          eventType: 'session_disconnected',
          severity:  'warning',
          detail:    `Session disconnected (${phoneNumber}) — will auto-reconnect`,
          clientId,
          sessionId: SESSION_ID,
          metadata:  { phoneNumber },
        }).catch((err: unknown) => workerLogger.error({ err }, 'session_disconnected event write failed'))
      } else if (current === 'banned') {
        logEvent({
          eventType: 'session_disconnected',
          severity:  'critical',
          detail:    `Session logged out by WhatsApp (${phoneNumber})`,
          clientId,
          sessionId: SESSION_ID,
          metadata:  { phoneNumber, reason: 'logged_out' },
        }).catch((err: unknown) => workerLogger.error({ err }, 'session_disconnected event write failed'))
      }
    }
  }, 5_000)

  // ── GRACEFUL SHUTDOWN ─────────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    workerLogger.info('Session worker shutting down')
    clearInterval(heartbeat)
    clearInterval(statusPoll)

    await outboundWorker.close()
    await commandSubscriber.quit()
    await session.disconnect()
    await inboundQueue.close()
    await adminDb.end()

    workerLogger.info('Session worker stopped')
    process.exit(0)
  }

  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())

  workerLogger.info('Session worker ready')
}

start().catch((err: unknown) => {
  logger.error({ err, sessionId: SESSION_ID }, 'Session worker fatal error')
  process.exit(1)
})
