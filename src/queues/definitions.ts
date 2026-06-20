// ── QUEUE NAMES ───────────────────────────────────────────────
//
// outbound:{sessionId}  One queue per session — worker consumes only its own.
//                       Isolates session load and avoids cross-session routing.
// inbound              Global queue consumed by AI processing workers.
// ai                   Global queue for AI response generation jobs.
// webhooks             Global queue for webhook delivery with retry.
// analytics            Global queue for async usage event writes.

export const QUEUE = {
  outbound: (sessionId: string) => `outbound:${sessionId}`,
  inbound: 'inbound',
  ai: 'ai',
  webhooks: 'webhooks',
  analytics: 'analytics',
} as const

// ── REDIS CHANNELS (pub/sub) ──────────────────────────────────

export const CHANNEL = {
  sessionStatus: (sessionId: string) => `session:${sessionId}:status`,
  sessionCommand: (sessionId: string) => `session:${sessionId}:commands`,
  sessionQR: (sessionId: string) => `session:${sessionId}:qr`,
} as const

// ── REDIS KEYS ────────────────────────────────────────────────

export const KEY = {
  sessionHeartbeat: (sessionId: string) => `session:${sessionId}:heartbeat`,
  sessionCreds: (sessionId: string) => `session:${sessionId}:creds`,
  sessionKey: (sessionId: string, type: string, id: string) =>
    `session:${sessionId}:key:${type}:${id}`,
} as const

// Heartbeat TTL — if a worker misses this window it is considered dead
export const HEARTBEAT_TTL_SECONDS = 90
export const HEARTBEAT_INTERVAL_MS = 30_000

// ── JOB TYPES ─────────────────────────────────────────────────

export interface OutboundMessageJob {
  messageId: string        // UUID from messages table
  clientId: string
  sessionId: string
  to: string               // E.164 recipient
  content: string          // already varied by anti-detection layer
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document'
  mediaUrl?: string
  conversationId: string
  // Anti-detection context — worker uses these for timing decisions
  warmupStage: 'conversational' | 'light_cta' | 'unrestricted'
}

export interface InboundMessageJob {
  sessionId: string
  clientId: string
  from: string             // E.164 sender
  content: string
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document'
  mediaUrl?: string
  waMessageId: string
  timestamp: string        // ISO
}

export interface AIConversationJob {
  conversationId: string
  clientId: string
  messageId: string        // the inbound message that triggered this
  turnCount: number
  contextTokens: number
}

export interface WebhookDeliveryJob {
  deliveryId: string       // webhook_deliveries.id
}

export interface AnalyticsJob {
  clientId: string
  eventType: string
  quantity: number
  referenceId?: string
  metadata?: Record<string, unknown>
  occurredAt: string       // ISO
}

// Session command sent via Redis pub/sub (supervisor → worker)
export interface SessionCommand {
  command: 'disconnect' | 'reconnect' | 'pause_outbound' | 'resume_outbound'
}

// Status update sent via Redis pub/sub (worker → supervisor)
export interface SessionStatusUpdate {
  sessionId: string
  status: 'connecting' | 'connected' | 'disconnected' | 'banned' | 'error'
  riskScore?: number
  reason?: string
  timestamp: string        // ISO
}
