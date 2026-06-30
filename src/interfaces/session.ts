// ── WHATSAPP SESSION INTERFACE ────────────────────────────────
//
// Abstracts the underlying WhatsApp protocol implementation (Baileys).
// All session consumers depend on this interface. Baileys is the
// implementation — if the protocol changes, only the implementation
// changes.

export type SessionStatus = 'disconnected' | 'connecting' | 'connected' | 'banned'

export interface InboundMessage {
  waMessageId: string
  from: string              // E.164 sender phone number
  content: string
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document'
  mediaUrl?: string
  timestamp: Date
}

export interface SendMessageResult {
  waMessageId: string
  timestamp: Date
}

// QR stream emits one of four event shapes until the session connects
export type QREvent =
  | { type: 'qr'; code: string }         // new QR code, render and display
  | { type: 'connected' }                // session authenticated, QR no longer needed
  | { type: 'error'; reason: string }    // unrecoverable error during QR flow
  | { type: 'restart' }                  // WhatsApp 515 — worker must restart cleanly
  | { type: 'logged_out' }              // WhatsApp revoked session — fresh QR needed

export interface SessionProfile {
  name?: string | null
  description?: string | null
  pictureUrl?: string | null
}

export interface IWhatsAppSession {
  readonly sessionId: string
  readonly phoneNumber: string

  // Connect and restore a previously authenticated session.
  // Throws SessionError if credentials are missing or invalid.
  connect(): Promise<void>

  // Disconnect cleanly — drains in-progress sends before closing.
  disconnect(): Promise<void>

  // Send a text message. Throws SessionError if not connected.
  sendMessage(to: string, content: string): Promise<SendMessageResult>

  // Send a composing (typing) indicator to recipient.
  // Called by the anti-detection layer before sending — creates realistic
  // typing pause visible to the recipient.
  sendComposing(to: string, durationMs: number): Promise<void>

  // Mark an inbound message as read. Delays are applied by the caller
  // (anti-detection layer) to mimic human read behaviour.
  markRead(waMessageId: string): Promise<void>

  // Stream QR code updates during initial onboarding. The generator
  // emits events until connected or an error occurs, then returns.
  qrStream(): AsyncGenerator<QREvent>

  // Register a handler for inbound messages. Only one handler per session.
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void

  // Register a callback that fires once when the session successfully connects.
  onConnected(handler: () => Promise<void>): void

  // Push WhatsApp Business profile fields to the connected account.
  applyProfile(profile: SessionProfile): Promise<void>

  // Request a pairing code (OTP alternative to QR scanning).
  // phoneNumber must be in E.164 digits only (no +), e.g. "2348012345678".
  requestPairingCode(phoneNumber: string): Promise<string>

  getStatus(): SessionStatus

  // Device fingerprint that must be preserved and restored on reconnect.
  // The session supervisor persists this to PostgreSQL after every change.
  getDeviceFingerprint(): Record<string, unknown> | null
}

// ── SESSION SUPERVISOR INTERFACE ──────────────────────────────
//
// Manages the lifecycle of all session processes. Each WhatsApp session
// runs as its own child process. The supervisor is the single point of
// control for starting, stopping, monitoring, and restarting sessions.

export interface SessionHealth {
  sessionId: string
  phoneNumber: string
  status: SessionStatus
  riskScore: number
  lastHeartbeatAt: Date | null
  messagesSentTotal: number
}

export interface ISessionSupervisor {
  // Start a session process for the given session ID.
  // Loads credentials from PostgreSQL, warms Redis cache, spawns process.
  startSession(sessionId: string): Promise<void>

  // Gracefully stop a session process.
  stopSession(sessionId: string): Promise<void>

  // Returns health snapshot for a single session.
  getHealth(sessionId: string): Promise<SessionHealth>

  // Returns health snapshots for all managed sessions.
  getAllHealth(): Promise<SessionHealth[]>

  // Called when the supervisor detects a session has crashed.
  // Handles exponential backoff with jitter before restart.
  handleCrash(sessionId: string, exitCode: number | null): Promise<void>
}
