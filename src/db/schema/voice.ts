// ── VOICE CALLS ───────────────────────────────────────────────

export type CallStatus =
  | 'initiated'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'busy'

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
  ts: string  // ISO timestamp
}

export interface VoiceCall {
  id: string
  clientId: string
  contactId: string
  // Linked messaging conversation — AI has full context from messages + this call
  conversationId: string | null
  voiceProfileId: string | null
  toNumber: string
  fromNumber: string
  status: CallStatus
  initiatedAt: Date
  answeredAt: Date | null
  endedAt: Date | null
  durationSeconds: number | null
  aiModel: string | null
  transcript: TranscriptTurn[] | null
  recordingPath: string | null
  freeswitchCallUuid: string | null
  sipCallId: string | null
  isBillable: boolean
  billedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
