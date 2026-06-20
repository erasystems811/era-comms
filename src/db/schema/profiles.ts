// ── COMMUNICATION PROFILES ────────────────────────────────────

export type ProfileLevel = 1 | 2 | 3
export type ProfileCreatedBy = 'system' | 'operator' | 'client'

export interface CommunicationProfile {
  id: string
  clientId: string
  level: ProfileLevel
  // Null until first version is inserted (deferred FK)
  currentVersionId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface FAQ {
  question: string
  answer: string
}

export interface BusinessHoursSlot {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6  // 0 = Sunday
  open: string   // "09:00"
  close: string  // "17:00"
}

export interface BusinessHours {
  timezone: string
  schedule: BusinessHoursSlot[]
}

export interface CommunicationProfileVersion {
  id: string
  profileId: string
  clientId: string  // denormalized for RLS
  versionNumber: number
  persona: string
  tone: string
  permittedTopics: string[]
  prohibitedTopics: string[]
  escalationTriggers: string[]
  systemPrompt: string
  faqs: FAQ[] | null
  businessHours: BusinessHours | null
  createdBy: ProfileCreatedBy
  createdAt: Date
}

// Resolved profile loaded for AI calls — the shape the AI engine consumes
export interface ResolvedProfile {
  versionId: string
  systemPrompt: string
  persona: string
  tone: string
  permittedTopics: string[]
  prohibitedTopics: string[]
  escalationTriggers: string[]
  businessHours: BusinessHours | null
  faqs: FAQ[] | null
}
