// ── USAGE EVENTS (TimescaleDB hypertable) ─────────────────────

export type UsageEventType =
  | 'message_sent'
  | 'message_received'
  | 'ai_turn'
  | 'ai_tokens'
  | 'voice_call_initiated'
  | 'voice_call_second'
  | 'webhook_delivered'

export interface UsageEvent {
  id: string
  clientId: string
  eventType: UsageEventType
  quantity: number
  referenceId: string | null    // message_id, call_id, etc.
  metadata: Record<string, unknown> | null
  occurredAt: Date
}

// Shape of hourly and daily continuous aggregate views
export interface UsageAggregate {
  bucket: Date
  clientId: string
  eventType: UsageEventType
  totalQuantity: number
  eventCount: number
}

// ── SESSION HEALTH SNAPSHOTS (TimescaleDB hypertable) ─────────

export interface SessionHealthSnapshot {
  sessionId: string
  status: string
  riskScore: number
  isConnected: boolean
  messagesSent1h: number
  messagesReceived1h: number
  outboundQueueDepth: number
  snapshotAt: Date
}

// ── ALERT HISTORY ─────────────────────────────────────────────

export type AlertSeverity = 'warning' | 'critical'

export type AlertType =
  | 'session_disconnected'
  | 'session_banned'
  | 'delivery_rate_drop'
  | 'risk_score_critical'
  | 'queue_depth_exceeded'
  | 'db_pool_exhausted'
  | 'plan_limit_exceeded'
  | 'backup_activated'

export interface AlertRecord {
  id: string
  alertType: AlertType
  severity: AlertSeverity
  clientId: string | null      // null = system-wide
  sessionId: string | null
  message: string
  metadata: Record<string, unknown> | null
  waDelivered: boolean
  waMessageId: string | null
  resolvedAt: Date | null
  createdAt: Date
}
