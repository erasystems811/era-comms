import makeWASocket, {
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
  InboundMessage,
  SendMessageResult,
  QREvent,
} from '../interfaces/session.js'
import { makeAuthState, saveCredentials } from './credential-store.js'
import { adminDb } from '../db/client.js'
import { logger } from '../shared/logger.js'
import { SessionError } from '../shared/errors.js'

// Baileys is very verbose — give it a silent logger in production
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
    if (this._status === 'banned') throw new SessionError('Session is permanently banned')

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
      agent = new SocksProxyAgent(proxyUrl)
    }

    this.socket = makeWASocket({
      auth: state,
      browser: this._fingerprint.browser,
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
      await this.socket.logout()
    } catch {
      // logout may fail if already disconnected — that's fine
    } finally {
      this.socket.end(undefined)
      this.socket = null
      this._status = 'disconnected'
    }
  }

  async sendMessage(to: string, content: string): Promise<SendMessageResult> {
    if (!this.socket || this._status !== 'connected') {
      throw new SessionError(`Session ${this.sessionId} is not connected`)
    }

    const jid = jidNormalizedUser(`${to}@s.whatsapp.net`)
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

    const jid = jidNormalizedUser(`${to}@s.whatsapp.net`)
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
      yield { type: 'error', reason: 'Session is permanently banned' }
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
      if (event.type === 'connected' || event.type === 'error') {
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
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        this._status = 'banned'
        logger.warn({ sessionId: this.sessionId }, 'WhatsApp session logged out / banned')
        await this.updateDbStatus('banned')
        this.emitQR({ type: 'error', reason: 'Session banned or logged out by WhatsApp' })
      } else {
        this._status = 'disconnected'
        logger.warn(
          { sessionId: this.sessionId, statusCode },
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
