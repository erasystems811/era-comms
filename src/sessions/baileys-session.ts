import makeWASocket, {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  proto,
} from '@whiskeysockets/baileys'
import type { ConnectionState, WASocket } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import type {
  IWhatsAppSession,
  SessionStatus,
  SessionProfile,
  InboundMessage,
  SendMessageResult,
  QREvent,
} from '../interfaces/session.js'
import { makeAuthState, saveCredentials, clearCredentials } from './credential-store.js'
import { adminDb } from '../db/client.js'
import { logger } from '../shared/logger.js'
import { SessionError } from '../shared/errors.js'

const baileysLogger = pino({ level: 'silent' })

// Device fingerprint stored in whatsapp_sessions.device_fingerprint
// Must be identical on every reconnect for the same session.
interface DeviceFingerprint {
  browser: [string, string, string]
}

function defaultFingerprint(): DeviceFingerprint {
  // Mimics a standard Chrome browser on Windows — stable across reconnects
  return {
    browser: ['ERA Comms', 'Chrome', '120.0.0'],
  }
}

export class BaileysSession implements IWhatsAppSession {
  readonly sessionId: string
  readonly phoneNumber: string

  private socket: WASocket | null = null
  private _status: SessionStatus = 'disconnected'
  private _fingerprint: DeviceFingerprint | null = null
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private connectedHandler: (() => Promise<void>) | null = null

  // QR event listeners — one per concurrent WebSocket connection (usually one)
  private qrListeners: Array<(event: QREvent) => void> = []

  constructor(sessionId: string, phoneNumber: string) {
    this.sessionId = sessionId
    this.phoneNumber = phoneNumber
  }

  getStatus(): SessionStatus {
    return this._status
  }

  getDeviceFingerprint(): Record<string, unknown> | null {
    return this._fingerprint as Record<string, unknown> | null
  }

  async connect(): Promise<void> {
    if (this._status === 'connected') return
    if (this._status === 'banned') throw new SessionError('Session is banned — replace the number')

    this._status = 'connecting'

    // Load or create device fingerprint
    const storedFingerprint = await this.loadFingerprint()
    this._fingerprint = storedFingerprint ?? defaultFingerprint()
    if (!storedFingerprint) {
      await this.saveFingerprint(this._fingerprint)
    }

    const { state, saveCreds } = await makeAuthState(this.sessionId)

    // If WHATSAPP_PROXY_URL is set (e.g. socks5://user:pass@host:port),
    // route through it so WhatsApp accepts connections from this server IP.
    let agent: import('https').Agent | undefined
    const proxyUrl = process.env.WHATSAPP_PROXY_URL
    if (proxyUrl) {
      const { SocksProxyAgent } = await import('socks-proxy-agent')
      agent = new SocksProxyAgent(proxyUrl) as unknown as import('https').Agent
    }

    this.socket = makeWASocket({
      auth: state,
      browser: Browsers.windows('Chrome'),
      logger: baileysLogger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30_000,
      getMessage: async () => undefined,
      ...(agent ? { agent } : {}),
    })

    this.socket.ev.on('creds.update', saveCreds)

    this.socket.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update)
    })

    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue
        void this.handleInboundMessage(msg)
      }
    })
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return
    try {
      this.socket.end(undefined)
    } catch {
      // ignore
    } finally {
      this.socket = null
      this._status = 'disconnected'
    }
  }

  async sendMessage(to: string, content: string): Promise<SendMessageResult> {
    if (!this.socket || this._status !== 'connected') {
      throw new SessionError(`Session ${this.sessionId} is not connected`)
    }

    const rawNumber = to.replace(/^\+/, '')

    // Verify the number is registered on WhatsApp before sending.
    // Without this, Baileys can return a message ID for unregistered numbers
    // and the message silently disappears — giving a false 'sent' status.
    const waResult = await this.socket.onWhatsApp(rawNumber)
    const waCheck = waResult?.[0]
    if (!waCheck?.exists) {
      throw new SessionError(`${to} is not registered on WhatsApp`)
    }

    const jid = waCheck.jid ?? jidNormalizedUser(`${rawNumber}@s.whatsapp.net`)
    const result = await this.socket.sendMessage(jid, { text: content })

    if (!result?.key?.id) {
      throw new SessionError('WhatsApp did not return a message ID')
    }

    return {
      waMessageId: result.key.id,
      timestamp: new Date(),
    }
  }

  async sendComposing(to: string, durationMs: number): Promise<void> {
    if (!this.socket || this._status !== 'connected') return

    const jid = jidNormalizedUser(`${to.replace(/^\+/, '')}@s.whatsapp.net`)
    await this.socket.sendPresenceUpdate('composing', jid)

    // Hold for the specified duration, then clear the typing indicator
    await new Promise((r) => setTimeout(r, durationMs))
    await this.socket.sendPresenceUpdate('paused', jid)
  }

  async markRead(waMessageId: string): Promise<void> {
    if (!this.socket || this._status !== 'connected') return

    await this.socket.readMessages([
      {
        id: waMessageId,
        remoteJid: undefined,
        fromMe: false,
      },
    ])
  }

  async *qrStream(): AsyncGenerator<QREvent> {
    // If already connected, signal immediately and return
    if (this._status === 'connected') {
      yield { type: 'connected' }
      return
    }

    if (this._status === 'banned') {
      yield { type: 'error', reason: 'This number has been banned by WhatsApp and cannot be reconnected. Please use a different number.' }
      return
    }

    // Buffer events that arrive before the consumer is ready to receive
    const buffer: QREvent[] = []
    let notifyConsumer: (() => void) | null = null
    let finished = false

    const listener = (event: QREvent): void => {
      buffer.push(event)
      notifyConsumer?.()
      notifyConsumer = null
      if (event.type === 'connected' || event.type === 'error' || event.type === 'logged_out' || event.type === 'restart') {
        finished = true
      }
    }

    this.qrListeners.push(listener)

    try {
      while (!finished || buffer.length > 0) {
        if (buffer.length === 0) {
          await new Promise<void>((r) => {
            notifyConsumer = r
          })
        }
        if (buffer.length > 0) {
          yield buffer.shift()!
        }
      }
    } finally {
      this.qrListeners = this.qrListeners.filter((l) => l !== listener)
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onConnected(handler: () => Promise<void>): void {
    this.connectedHandler = handler
  }

  async applyProfile(profile: SessionProfile): Promise<void> {
    if (!this.socket || this._status !== 'connected') return

    if (profile.name) {
      await this.socket.updateProfileName(profile.name)
    }

    if (profile.description) {
      await this.socket.updateProfileStatus(profile.description)
    }

    if (profile.pictureUrl) {
      let buf: Buffer
      if (profile.pictureUrl.startsWith('data:')) {
        const base64 = profile.pictureUrl.split(',')[1] ?? ''
        buf = Buffer.from(base64, 'base64')
      } else {
        const res = await fetch(profile.pictureUrl)
        if (!res.ok) throw new Error(`Failed to fetch profile picture: ${res.status}`)
        buf = Buffer.from(await res.arrayBuffer())
      }
      const jid = this.socket.user?.id
      if (jid) await this.socket.updateProfilePicture(jid, buf)
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.socket) throw new SessionError('Session socket not initialised — call connect() first')
    // Strip any non-digit characters (e.g. leading +)
    const digits = phoneNumber.replace(/\D/g, '')
    const code = await this.socket.requestPairingCode(digits)
    return code
  }

  // ── PRIVATE ─────────────────────────────────────────────────

  private emitQR(event: QREvent): void {
    for (const listener of this.qrListeners) {
      listener(event)
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      this._status = 'connecting'
      this.emitQR({ type: 'qr', code: qr })
    }

    if (connection === 'open') {
      this._status = 'connected'
      logger.info({ sessionId: this.sessionId }, 'WhatsApp session connected')
      await this.updateDbStatus('active')
      this.emitQR({ type: 'connected' })
      if (this.connectedHandler) void this.connectedHandler()
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        // 401 = WhatsApp revoked this device's credentials.
        // This happens when the user logs out from their phone, or WhatsApp
        // invalidates the session — it does NOT necessarily mean the number
        // is permanently banned. Clear the credentials so the next connect()
        // call gets a fresh QR, mark disconnected, then signal the worker
        // to exit cleanly (supervisor will restart with a new QR).
        logger.warn({ sessionId: this.sessionId }, 'WhatsApp session logged out — clearing credentials, worker will restart with fresh QR')
        await clearCredentials(this.sessionId).catch((err: unknown) =>
          logger.error({ err, sessionId: this.sessionId }, 'Failed to clear credentials on logout'),
        )
        this._status = 'disconnected'
        await this.updateDbStatus('disconnected')
        this.emitQR({ type: 'logged_out' })
      } else if (statusCode === DisconnectReason.restartRequired) {
        // 515 = WhatsApp asking us to reconnect to a different server.
        // Signal the session worker to exit cleanly so the supervisor can
        // restart it immediately. The QR WebSocket subscription stays alive
        // in the main process and will receive the QR from the new worker.
        logger.info({ sessionId: this.sessionId }, 'WhatsApp restart required (515) — signalling worker restart')
        this.emitQR({ type: 'restart' })
      } else {
        this._status = 'disconnected'
        logger.warn(
          { sessionId: this.sessionId, statusCode, err: lastDisconnect?.error },
          'WhatsApp session disconnected',
        )
        await this.updateDbStatus('disconnected')
        // If QR listeners are still waiting (i.e. we disconnected before ever
        // generating a QR), unblock them so the frontend shows an error rather
        // than spinning forever. The supervisor will restart this worker.
        if (this.qrListeners.length > 0) {
          const reason = statusCode
            ? `WhatsApp disconnected (code ${statusCode}). The worker will retry — please wait a moment then try again.`
            : 'WhatsApp connection closed before a QR was generated. Please try again.'
          this.emitQR({ type: 'error', reason })
        }
      }
    }
  }

  private async handleInboundMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!this.messageHandler) return

    const from = msg.key?.remoteJid?.replace('@s.whatsapp.net', '') ?? ''
    const content =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      ''

    if (!from || !content) return

    const inbound: InboundMessage = {
      waMessageId: msg.key?.id ?? '',
      from,
      content,
      contentType: 'text',
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
    }

    try {
      await this.messageHandler(inbound)
    } catch (err) {
      logger.error({ sessionId: this.sessionId, err }, 'Inbound message handler failed')
    }
  }

  private async updateDbStatus(status: string): Promise<void> {
    try {
      await adminDb`
        UPDATE whatsapp_sessions
        SET status     = ${status},
            updated_at = NOW(),
            ${status === 'active' ? adminDb`connected_at = NOW(),` : adminDb``}
            ${status === 'disconnected' || status === 'banned'
              ? adminDb`disconnected_at = NOW(),`
              : adminDb``}
            last_heartbeat_at = NOW()
        WHERE id = ${this.sessionId}
      `
    } catch (err) {
      logger.error({ sessionId: this.sessionId, err }, 'Failed to update session status in DB')
    }
  }

  private async loadFingerprint(): Promise<DeviceFingerprint | null> {
    const rows = await adminDb<Array<{ device_fingerprint: DeviceFingerprint | null }>>`
      SELECT device_fingerprint FROM whatsapp_sessions WHERE id = ${this.sessionId}
    `
    return rows[0]?.device_fingerprint ?? null
  }

  private async saveFingerprint(fp: DeviceFingerprint): Promise<void> {
    await adminDb`
      UPDATE whatsapp_sessions
      SET device_fingerprint = ${JSON.stringify(fp)}::jsonb,
          updated_at         = NOW()
      WHERE id = ${this.sessionId}
    `
  }
}
