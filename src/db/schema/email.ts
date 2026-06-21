// ── EMAIL MODULE TYPES ────────────────────────────────────────

export interface EmailDomain {
  id: string
  clientId: string
  domain: string
  postalServerId: string | null
  dkimPrivateKey: string | null
  dkimPublicKey: string | null
  spfVerified: boolean
  dkimVerified: boolean
  dmarcVerified: boolean
  mxVerified: boolean
  verifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface EmailTemplate {
  id: string
  clientId: string
  name: string
  subject: string
  htmlBody: string
  createdAt: Date
  updatedAt: Date
}

export interface EmailContactList {
  id: string
  clientId: string
  name: string
  createdAt: Date
  contactCount?: number
}

export interface EmailContact {
  id: string
  listId: string
  clientId: string
  email: string
  firstName: string | null
  lastName: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual'

export interface EmailSuppression {
  id: string
  email: string
  reason: SuppressionReason
  clientId: string | null
  createdAt: Date
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed'

export interface EmailCampaign {
  id: string
  clientId: string
  name: string
  templateId: string
  listId: string
  domainId: string
  fromName: string
  fromEmail: string
  status: CampaignStatus
  scheduledAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  totalRecipients: number
  totalSent: number
  totalDelivered: number
  totalClicked: number
  totalBounced: number
  totalComplained: number
  createdAt: Date
  updatedAt: Date
}

export type SendStatus = 'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed'

export interface EmailSend {
  id: string
  campaignId: string
  clientId: string
  email: string
  postalMessageId: string | null
  status: SendStatus
  deliveredAt: Date | null
  clickedAt: Date | null
  bouncedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
