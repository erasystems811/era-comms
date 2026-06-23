// ── ERA CONNECT ───────────────────────────────────────────────

export type ConnectInstanceStatus = 'online' | 'offline' | 'error'
export type ConnectMode = 'database' | 'browser'

export interface ConnectInstance {
  id: string
  hospitalName: string
  hospitalId: string | null
  apiKey: string
  status: ConnectInstanceStatus
  mode: ConnectMode
  emrEngine: string | null
  version: string | null
  patientsSynced: number
  carePlansSynced: number
  errorsTotal: number
  lastHeartbeatAt: Date | null
  lastErrorAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type ConnectEventType =
  | 'heartbeat'
  | 'startup'
  | 'shutdown'
  | 'patient_synced'
  | 'care_plan_synced'
  | 'sync_error'
  | 'auth_ok'
  | 'auth_failed'
  | 'db_connected'
  | 'db_error'
  | 'config_fetched'
  | 'config_updated'

export type ConnectEventStatus = 'ok' | 'error' | 'warning'

export interface ConnectEvent {
  id: string
  instanceId: string
  eventType: ConnectEventType
  status: ConnectEventStatus
  message: string
  patientMrn: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface ConnectConfig {
  id: string
  instanceId: string
  syncIntervalSeconds: number
  paused: boolean
  notifyEmail: string | null
  updatedAt: Date
}
