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

  await publishStatus({ status: 'connecting' })
  await session.connect()

  // Publish QR codes to Redis so the API WebSocket can forward them.
  // The generator yields until the session connects or fails — then closes.
  void (async () => {
    try {
      for await (const event of session.qrStream()) {
        await generalRedis.publish(CHANNEL.sessionQR(SESSION_ID), JSON.stringify(event))
      }
    } catch {
      // Generator closed — session connected or terminated
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
      // BullMQ data fields are typed via OutboundMessageJob — all are string.
      // Explicit locals satisfy strict null checks in the template literals below.
      const messageId: string = job.data.messageId
      const to: string = job.data.to
      const content: string = job.data.content

      workerLogger.debug({ messageId, to }, 'Processing outbound message')

      try {
        const result = await session.sendMessage(to, content)

        await adminDb`
          UPDATE messages
          SET wa_message_id = ${result.waMessageId},
              status        = 'sent',
              sent_at       = NOW()
          WHERE id = ${messageId}
        `
      } catch (err) {
        workerLogger.error({ messageId, err }, 'Failed to send message')

        await adminDb`UPDATE messages SET status = 'failed' WHERE id = ${messageId}`

        throw err // Re-throw so BullMQ applies retry policy
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
          current === 'connected' ? 'connected'
          : current === 'banned'  ? 'banned'
          :                         'disconnected',
      })
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
