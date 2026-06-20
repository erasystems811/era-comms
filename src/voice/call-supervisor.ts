// ── VOICE CALL SUPERVISOR ──────────────────────────────────────
//
// Manages the FreeSWITCH ESL inbound connection and routes incoming
// CHANNEL_CREATE events to per-call handlers.
//
// FreeSWITCH dialplan routes calls to ERA Comms by sending them to
// a socket application that connects to our ESL. When a new call
// arrives, CHANNEL_CREATE fires with the destination number. We look
// up the destination against whatsapp_sessions.phone_number to find
// the owning client, then spawn a call handler.
//
// If the ESL connection drops, the supervisor attempts reconnection
// with exponential backoff. Active calls continue to completion using
// the existing (still-connected at the FS side) channel.

import { adminDb } from '../db/client.js'
import { logger } from '../shared/logger.js'
import { ESLClient } from './esl-client.js'
import { handleCall } from './call-handler.js'
import type { ESLEvent } from './esl-client.js'

const log = logger.child({ component: 'call-supervisor' })

type SessionRow = {
  client_id:       string
}

type VoiceProfileRow = {
  id:              string
  level:           string
  cloned_voice_id: string | null
}

const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS  = 60_000

export class CallSupervisor {
  private esl: ESLClient | null = null
  private stopped = false
  private reconnectAttempts = 0

  async start(): Promise<void> {
    log.info('Call supervisor starting')
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.esl?.close()
    this.esl = null
    log.info('Call supervisor stopped')
  }

  // ── PRIVATE ────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const client = new ESLClient()

    try {
      await client.connect()
      this.esl = client
      this.reconnectAttempts = 0
      log.info('ESL connected — listening for calls')

      client.on('CHANNEL_CREATE', (evt: ESLEvent) => void this.onChannelCreate(evt))
      client.on('disconnect', () => void this.onDisconnect())
      client.on('error',      (err: unknown) => log.error({ err }, 'ESL error'))

    } catch (err) {
      log.error({ err }, 'ESL connection failed')
      void this.scheduleReconnect()
    }
  }

  private async onChannelCreate(evt: ESLEvent): Promise<void> {
    const uuid        = evt['Unique-ID']
    const fromNumber  = evt['Caller-Caller-ID-Number'] ?? ''
    const toNumber    = evt['Caller-Destination-Number'] ?? ''

    if (!uuid || !toNumber) return

    // Look up which client owns this destination number
    const sessions = (await adminDb`
      SELECT client_id
      FROM   whatsapp_sessions
      WHERE  phone_number = ${toNumber}
        AND  status NOT IN ('banned')
      LIMIT 1
    `) as unknown as SessionRow[]

    const session = sessions[0]
    if (!session) {
      log.warn({ uuid, toNumber }, 'No client found for destination number — hanging up')
      this.esl?.api(`uuid_hangup ${uuid} NO_ROUTE_DESTINATION`)
      return
    }

    const { client_id: clientId } = session

    // Load voice profile for this client (if any)
    const profileRows = (await adminDb`
      SELECT vp.id, vp.level, vp.cloned_voice_id
      FROM   voice_profiles vp
      JOIN   clients c ON c.voice_profile_id = vp.id
      WHERE  c.id = ${clientId}
        AND  vp.status = 'ready'
      LIMIT 1
    `) as unknown as VoiceProfileRow[]

    const voiceProfile = profileRows[0]
      ? { id: profileRows[0].id, level: profileRows[0].level, clonedVoiceId: profileRows[0].cloned_voice_id }
      : null

    log.info({ uuid, fromNumber, toNumber, clientId }, 'Routing call to handler')

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    void handleCall(this.esl!, uuid, fromNumber, toNumber, clientId, voiceProfile)
      .catch((err: unknown) => log.error({ err, uuid }, 'Call handler crashed'))
  }

  private async onDisconnect(): Promise<void> {
    if (this.stopped) return
    log.warn('ESL disconnected')
    void this.scheduleReconnect()
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped) return
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts), BACKOFF_MAX_MS)
    this.reconnectAttempts++
    log.info({ delayMs: delay, attempt: this.reconnectAttempts }, 'Scheduling ESL reconnect')
    await new Promise<void>((r) => setTimeout(r, delay))
    if (!this.stopped) await this.connect()
  }
}
