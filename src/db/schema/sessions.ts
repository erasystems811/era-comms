// ── WHATSAPP SESSIONS ─────────────────────────────────────────

export type SessionRole = 'primary' | 'backup'

export type SessionStatus =
  | 'pending_qr'    // awaiting QR scan at onboarding
  | 'warming_up'    // QR scanned, in warmup period
  | 'active'        // fully operational
  | 'flagged'       // delivery degraded, risk score elevated — stays primary
  | 'cooldown'      // temporary send pause, recovering
  | 'banned'        // permanent, requires replacement number
  | 'disconnected'  // supervisor will attempt reconnect

// Baileys auth state — structure managed by Baileys, treated as opaque
export type DeviceFingerprint = Record<string, unknown>

export interface WhatsappSession {
  id: string
  clientId: string
  phoneNumber: string
  role: SessionRole
  status: SessionStatus

  // AES-256-GCM encrypted Baileys credentials (base64 encoded components)
  credentialsEncrypted: string | null
  credentialsIv: string | null
  credentialsTag: string | null
  credentialsUpdatedAt: Date | null

  // Must be identical on every reconnect — stored so it survives Redis wipes
  deviceFingerprint: DeviceFingerprint | null

  // 0.000 (clean) to 1.000 (critical risk)
  riskScore: number
  riskUpdatedAt: Date | null

  connectedAt: Date | null
  lastHeartbeatAt: Date | null
  disconnectedAt: Date | null

  messageSentTotal: number
  messagesReceivedTotal: number

  cooldownUntil: Date | null

  // Set on backup numbers; points to the primary this backup covers
  primarySessionId: string | null
  activatedAsBackupAt: Date | null

  createdAt: Date
  updatedAt: Date
}

// ── WARMUP PROFILES ───────────────────────────────────────────

export interface WarmupCurvePoint {
  day: number
  cap: number
}

export type ContentGuidance = 'conversational' | 'light_cta' | 'unrestricted'

export type ContentStage =
  | { until_day: number; guidance: 'conversational' | 'light_cta' }
  | { from_day: number; guidance: 'unrestricted' }

export interface WarmupProfile {
  id: string
  sessionId: string
  clientId: string
  volumeCurve: WarmupCurvePoint[]
  contentStages: ContentStage[]
  startedAt: Date
  currentDay: number
  isComplete: boolean
  skipWarmup: boolean
  createdAt: Date
  updatedAt: Date
}

// Computed warmup state — what the system actually enforces right now
export interface WarmupState {
  currentDay: number
  dailyCap: number
  contentGuidance: ContentGuidance
  isComplete: boolean
  estimatedCompletionDate: Date
}

// ── VOICE PROFILES (Coqui XTTS v2) ───────────────────────────

export type VoiceLevel = 'default' | 'premium' | 'enterprise'
export type VoiceStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface VoiceProfile {
  id: string
  clientId: string | null  // null = ERA Comms default voice, shared across all base clients
  name: string
  level: VoiceLevel
  modelType: string
  voiceSamplePath: string | null
  clonedVoiceId: string | null
  status: VoiceStatus
  clonedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
