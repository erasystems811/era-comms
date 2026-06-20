// ── CONTACTS ──────────────────────────────────────────────────

export interface Contact {
  id: string
  clientId: string
  phoneNumber: string
  displayName: string | null
  metadata: Record<string, unknown>
  totalConversations: number
  lastContactedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ── CONVERSATIONS ─────────────────────────────────────────────

export type ConversationStatus = 'active' | 'escalated' | 'closed'

export interface Conversation {
  id: string
  clientId: string
  contactId: string
  sessionId: string
  // Pinned at conversation start — never changes for the life of this conversation
  profileVersionId: string
  status: ConversationStatus
  aiActive: boolean

  escalatedAt: Date | null
  escalationReason: string | null
  resumedAt: Date | null

  totalTurns: number
  contextSummary: string | null
  lastSummarizedAt: Date | null
  lastAiModel: string | null

  createdAt: Date
  updatedAt: Date
}

// ── MESSAGES ──────────────────────────────────────────────────

export type MessageDirection = 'outbound' | 'inbound'
export type MessageContentType = 'text' | 'image' | 'audio' | 'video' | 'document'
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'dead_lettered'
export type WarmupStage = 'conversational' | 'light_cta' | 'unrestricted'

export interface Message {
  id: string
  conversationId: string
  clientId: string      // denormalized for RLS
  sessionId: string
  direction: MessageDirection
  content: string
  contentType: MessageContentType
  mediaUrl: string | null

  // Client-supplied. Unique per client. Guarantees at-most-once delivery.
  idempotencyKey: string

  waMessageId: string | null

  status: MessageStatus

  // Anti-detection audit trail
  originalContent: string | null   // content before variation pass
  wasVaried: boolean
  warmupStage: WarmupStage | null
  scheduledFor: Date | null         // time-window adjusted send time
  sentAt: Date | null

  aiGenerated: boolean
  aiModel: string | null
  // TRUE for messages sent by human during escalation — bypass AI variation
  aiBypassed: boolean

  isBillable: boolean
  billedAt: Date | null

  createdAt: Date
}

// ── MESSAGE EVENTS ────────────────────────────────────────────

export type MessageEventType = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'retry'

export interface MessageEvent {
  id: string
  messageId: string
  clientId: string      // denormalized for RLS
  eventType: MessageEventType
  failureReason: string | null
  waEventId: string | null
  metadata: Record<string, unknown> | null
  occurredAt: Date
}

// ── WEBHOOK EVENTS AND DELIVERIES ────────────────────────────

export type WebhookEventType =
  | 'message.sent'
  | 'message.delivered'
  | 'message.read'
  | 'message.failed'
  | 'conversation.escalated'
  | 'conversation.resumed'
  | 'call.completed'
  | 'call.failed'
  | 'session.connected'
  | 'session.disconnected'
  | 'session.banned'

export type WebhookEndpointStatus = 'active' | 'disabled'

export interface WebhookEndpoint {
  id: string
  clientId: string
  url: string
  secret: string    // HMAC-SHA256 signing secret
  events: WebhookEventType[]
  status: WebhookEndpointStatus
  createdAt: Date
  updatedAt: Date
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_lettered'

export interface WebhookDelivery {
  id: string
  endpointId: string
  clientId: string
  eventType: WebhookEventType
  payload: Record<string, unknown>
  status: WebhookDeliveryStatus
  attempts: number
  maxAttempts: number
  nextRetryAt: Date | null
  lastAttemptAt: Date | null
  responseStatus: number | null
  responseBody: string | null
  createdAt: Date
}
