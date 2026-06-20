// ── PLANS ─────────────────────────────────────────────────────

export type BillingModel = 'none' | 'usage_based' | 'plan_based'

export interface Plan {
  id: string
  name: string
  displayName: string
  aiEnabled: boolean
  voiceEnabled: boolean
  premiumVoiceEnabled: boolean
  analyticsEnabled: boolean
  monthlyMessageCap: number | null
  dailyMessageCap: number | null
  hourlyMessageCap: number | null
  maxSessions: number
  maxContacts: number | null
  billingModel: BillingModel
  monthlyFee: number | null
  pricePerMessage: number | null
  pricePerAiTurn: number | null
  pricePerCallMinute: number | null
  createdAt: Date
  updatedAt: Date
}

// ── BUSINESS CATEGORIES ───────────────────────────────────────

export type BusinessCategorySlug =
  | 'healthcare'
  | 'retail'
  | 'hospitality'
  | 'logistics'
  | 'finance'
  | 'education'
  | 'real_estate'
  | 'professional_services'
  | 'ecommerce'
  | 'general'

export interface BusinessCategory {
  id: string
  slug: BusinessCategorySlug
  name: string
  description: string | null
  createdAt: Date
}

// ── DEFAULT COMMUNICATION PROFILES ───────────────────────────

export interface DefaultCommunicationProfile {
  id: string
  categoryId: string
  persona: string
  tone: string
  permittedTopics: string[]
  prohibitedTopics: string[]
  escalationTriggers: string[]
  systemPrompt: string
  createdAt: Date
}

// ── CLIENTS ───────────────────────────────────────────────────

export type ClientType = 'internal' | 'external'
export type ClientStatus = 'active' | 'suspended' | 'pending'

export interface Client {
  id: string
  name: string
  type: ClientType
  planId: string
  categoryId: string | null
  status: ClientStatus
  voiceProfileId: string | null
  contactEmail: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

// ── API KEYS ──────────────────────────────────────────────────

export type ApiKeyScope = 'messaging' | 'calls' | 'conversations' | 'analytics' | 'admin'
export type ApiKeyEnvironment = 'live' | 'test'
export type ApiKeyStatus = 'active' | 'revoked' | 'expired'

export interface ApiKey {
  id: string
  clientId: string
  keyHash: string
  keyPrefix: string
  environment: ApiKeyEnvironment
  scopes: ApiKeyScope[]
  status: ApiKeyStatus
  expiresAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
}
