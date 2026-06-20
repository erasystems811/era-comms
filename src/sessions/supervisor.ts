import { spawn, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import { adminDb } from '../db/client.js'
import { redis } from '../db/redis.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import {
  KEY,
  CHANNEL,
  HEARTBEAT_TTL_SECONDS,
} from '../queues/definitions.js'
import type { SessionStatusUpdate, SessionCommand } from '../queues/definitions.js'
import type {
  ISessionSupervisor,
  SessionHealth,
} from '../interfaces/session.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Backoff config for crashed session restarts
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 120_000
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000

interface WorkerState {
  process: ChildProcess
  sessionId: string
  startedAt: Date
  restartAttempts: number
  stopped: boolean  // true when intentionally stopped — do not restart
}

export class SessionSupervisor implements ISessionSupervisor {
  private workers = new Map<string, WorkerState>()
  private statusSubscriber: Redis | null = null
  private heartbeatChecker: NodeJS.Timeout | null = null

  // ── LIFECYCLE ─────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info('Session supervisor starting')

    // Subscribe to status events from all session workers
    this.statusSubscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null })
    await this.statusSubscriber.psubscribe('session:*:status')
    this.statusSubscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
      const update = JSON.parse(message) as SessionStatusUpdate
      void this.handleStatusUpdate(update)
    })

    // Start heartbeat monitor
    this.heartbeatChecker = setInterval(
      () => void this.checkHeartbeats(),
      HEARTBEAT_CHECK_INTERVAL_MS,
    )

    // Load all non-banned sessions from the database and start them
    const sessions = await adminDb<Array<{ id: string; status: string }>>`
      SELECT id, status FROM whatsapp_sessions
      WHERE status NOT IN ('banned')
      ORDER BY created_at ASC
    `

    logger.info({ count: sessions.length }, 'Loading sessions')

    for (const session of sessions) {
      await this.startSession(session.id)
      // Stagger starts to avoid hammering WhatsApp simultaneously
      await delay(500 + Math.random() * 500)
    }

    logger.info('Session supervisor ready')
  }

  async stop(): Promise<void> {
    logger.info('Session supervisor stopping')

    if (this.heartbeatChecker) {
      clearInterval(this.heartbeatChecker)
      this.heartbeatChecker = null
    }

    if (this.statusSubscriber) {
      await this.statusSubscriber.quit()
      this.statusSubscriber = null
    }

    // Stop all workers
    const stopPromises = Array.from(this.workers.keys()).map((id) =>
      this.stopSession(id),
    )
    await Promise.allSettled(stopPromises)
  }

  // ── ISessionSupervisor ────────────────────────────────────────

  async startSession(sessionId: string): Promise<void> {
    if (this.workers.has(sessionId)) {
      logger.warn({ sessionId }, 'Session already has a running worker')
      return
    }

    const proc = this.spawnWorker(sessionId)
    const state: WorkerState = {
      process: proc,
      sessionId,
      startedAt: new Date(),
      restartAttempts: 0,
      stopped: false,
    }

    this.workers.set(sessionId, state)

    proc.on('exit', (code, signal) => {
      logger.warn({ sessionId, code, signal }, 'Session worker exited')
      this.workers.delete(sessionId)

      if (!state.stopped) {
        void this.handleCrash(sessionId, code)
      }
    })

    logger.info({ sessionId }, 'Session worker spawned')
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.workers.get(sessionId)
    if (!state) return

    state.stopped = true

    // Send SIGTERM — the worker drains and exits cleanly
    state.process.kill('SIGTERM')

    // Give it 10 seconds to shut down, then force kill
    await Promise.race([
      new Promise<void>((r) => state.process.once('exit', r)),
      delay(10_000),
    ])

    if (state.process.exitCode === null) {
      state.process.kill('SIGKILL')
    }

    this.workers.delete(sessionId)
    logger.info({ sessionId }, 'Session worker stopped')
  }

  async getHealth(sessionId: string): Promise<SessionHealth> {
    const heartbeat = await redis.get(KEY.sessionHeartbeat(sessionId))
    const rows = await adminDb<Array<{
      phone_number: string
      status: string
      risk_score: string
      last_heartbeat_at: Date | null
      messages_sent_total: string
    }>>`
      SELECT phone_number, status, risk_score, last_heartbeat_at, messages_sent_total
      FROM whatsapp_sessions WHERE id = ${sessionId}
    `

    const row = rows[0]
    return {
      sessionId,
      phoneNumber: row?.phone_number ?? '',
      status: heartbeat ? (row?.status === 'active' ? 'connected' : 'disconnected') : 'disconnected',
      riskScore: parseFloat(row?.risk_score ?? '0'),
      lastHeartbeatAt: row?.last_heartbeat_at ?? null,
      messagesSentTotal: parseInt(row?.messages_sent_total ?? '0', 10),
    }
  }

  async getAllHealth(): Promise<SessionHealth[]> {
    const sessions = await adminDb<Array<{ id: string }>>`
      SELECT id FROM whatsapp_sessions ORDER BY created_at ASC
    `
    return Promise.all(sessions.map((s) => this.getHealth(s.id)))
  }

  async handleCrash(sessionId: string, exitCode: number | null): Promise<void> {
    const rows = await adminDb<Array<{ status: string }>>`
      SELECT status FROM whatsapp_sessions WHERE id = ${sessionId}
    `
    const status = rows[0]?.status

    if (status === 'banned') {
      logger.info({ sessionId }, 'Banned session crashed — not restarting')
      return
    }

    // Get or reconstruct restart attempt count
    const existing = this.workers.get(sessionId)
    const attempt = existing?.restartAttempts ?? 0

    const backoffMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, attempt),
      BACKOFF_MAX_MS,
    )
    // Add 25% jitter so multiple crashed sessions don't all reconnect simultaneously
    const jitter = backoffMs * 0.25 * Math.random()
    const wait = Math.round(backoffMs + jitter)

    logger.info(
      { sessionId, exitCode, attempt, waitMs: wait },
      'Scheduling session restart',
    )

    await delay(wait)

    await adminDb`
      UPDATE whatsapp_sessions SET status = 'disconnected' WHERE id = ${sessionId}
    `

    await this.startSession(sessionId)

    // Update attempt counter on the new worker state
    const newState = this.workers.get(sessionId)
    if (newState) newState.restartAttempts = attempt + 1
  }

  // ── PRIVATE ───────────────────────────────────────────────────

  private spawnWorker(sessionId: string): ChildProcess {
    const isProduction = config.isProduction

    let cmd: string
    let args: string[]

    if (isProduction) {
      const workerPath = resolve(__dirname, 'session-worker.js')
      cmd = process.execPath
      args = [workerPath, sessionId]
    } else {
      // Development: use tsx to run TypeScript directly
      const txsBin = resolve(process.cwd(), 'node_modules', '.bin', 'tsx')
      const workerPath = resolve(process.cwd(), 'src', 'sessions', 'session-worker.ts')
      cmd = txsBin
      args = [workerPath, sessionId]
    }

    return spawn(cmd, args, {
      stdio: 'inherit',
      env: process.env as NodeJS.ProcessEnv,
    })
  }

  private async handleStatusUpdate(update: SessionStatusUpdate): Promise<void> {
    const { sessionId, status } = update

    logger.debug({ sessionId, status }, 'Session status update')

    if (status === 'banned') {
      const worker = this.workers.get(sessionId)
      if (worker) worker.stopped = true

      // Check if this client has a backup number to activate
      await this.activateBackupIfAvailable(sessionId)
    }
  }

  private async activateBackupIfAvailable(primarySessionId: string): Promise<void> {
    // Find backup session for the same client as this primary
    const backups = await adminDb<Array<{ id: string }>>`
      SELECT ws_backup.id
      FROM whatsapp_sessions ws_backup
      JOIN whatsapp_sessions ws_primary ON ws_primary.id = ${primarySessionId}
      WHERE ws_backup.client_id    = ws_primary.client_id
        AND ws_backup.role         = 'backup'
        AND ws_backup.primary_session_id = ${primarySessionId}
        AND ws_backup.status      != 'banned'
      LIMIT 1
    `

    if (backups.length === 0) {
      logger.warn(
        { primarySessionId },
        'Primary banned with no backup available — operator action required',
      )
      return
    }

    const backupId = backups[0]!.id

    logger.info(
      { primarySessionId, backupId },
      'Activating backup number — primary is banned',
    )

    await adminDb`
      UPDATE whatsapp_sessions
      SET activated_as_backup_at = NOW(),
          updated_at             = NOW()
      WHERE id = ${backupId}
    `

    // The backup is already a running session (it was warmed up)
    // No spawn needed — it just starts accepting outbound jobs
  }

  private async checkHeartbeats(): Promise<void> {
    const runningIds = Array.from(this.workers.keys())
    if (runningIds.length === 0) return

    for (const sessionId of runningIds) {
      const state = this.workers.get(sessionId)
      if (!state || state.stopped) continue

      const alive = await redis.get(KEY.sessionHeartbeat(sessionId))
      if (!alive) {
        logger.warn({ sessionId }, 'Heartbeat expired — session worker is dead')
        state.process.kill('SIGKILL')
        this.workers.delete(sessionId)
        void this.handleCrash(sessionId, null)
      }
    }
  }
}

// ── COMMAND HELPERS (for API layer) ──────────────────────────

const commandPublisher = new Redis(config.redis.url, { maxRetriesPerRequest: null })

export async function sendSessionCommand(
  sessionId: string,
  command: SessionCommand['command'],
): Promise<void> {
  const payload: SessionCommand = { command }
  await commandPublisher.publish(CHANNEL.sessionCommand(sessionId), JSON.stringify(payload))
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
