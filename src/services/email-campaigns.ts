// ── EMAIL CAMPAIGN SERVICE ────────────────────────────────────

import { adminDb } from '../db/client.js'
import { logger }  from '../shared/logger.js'
import { config }  from '../shared/config.js'
import { Queue }   from 'bullmq'
import { QUEUE }   from '../queues/definitions.js'

const log = logger.child({ component: 'email-campaigns' })

// ── Campaign queue ────────────────────────────────────────────

function getCampaignQueue() {
  return new Queue(QUEUE.emailCampaign, { connection: { url: config.redis.url } })
}

// ── Suppression check ─────────────────────────────────────────
// Returns true if the email is suppressed (must NOT send).

export async function isSuppressed(email: string, clientId: string): Promise<boolean> {
  const rows = await adminDb<{ id: string }[]>`
    SELECT id FROM email_suppressions
    WHERE email = ${email.toLowerCase()}
      AND (client_id = ${clientId} OR client_id IS NULL)
    LIMIT 1
  `
  return rows.length > 0
}

// ── Launch campaign ───────────────────────────────────────────
// Transitions campaign to 'sending', counts recipients, enqueues one
// BullMQ job per batch of 50 contacts. Returns the total recipient count.

export async function launchCampaign(campaignId: string): Promise<{ queued: number }> {
  // Mark as sending
  await adminDb`
    UPDATE email_campaigns
    SET status = 'sending', started_at = NOW(), updated_at = NOW()
    WHERE id = ${campaignId}
  `

  // Fetch all contacts in the list, excluding suppressed
  const contacts = await adminDb<{ id: string; email: string; first_name: string | null; last_name: string | null }[]>`
    SELECT ec.id, ec.email, ec.first_name, ec.last_name
    FROM email_contacts ec
    JOIN email_campaigns camp ON camp.list_id = ec.list_id
    WHERE camp.id = ${campaignId}
      AND NOT EXISTS (
        SELECT 1 FROM email_suppressions s
        WHERE s.email = ec.email
          AND (s.client_id = camp.client_id OR s.client_id IS NULL)
      )
  `

  // Update total_recipients
  await adminDb`
    UPDATE email_campaigns
    SET total_recipients = ${contacts.length}, updated_at = NOW()
    WHERE id = ${campaignId}
  `

  if (contacts.length > 0) {
    const [camp] = await adminDb<{ client_id: string }[]>`
      SELECT client_id FROM email_campaigns WHERE id = ${campaignId}
    `
    if (!camp) throw new Error(`Campaign ${campaignId} not found`)

    // Bulk-insert all send rows in one query using unnest
    const emails     = contacts.map(c => c.email.toLowerCase())
    const clientIds  = contacts.map(() => camp.client_id)
    const campaignIds = contacts.map(() => campaignId)
    const statuses   = contacts.map(() => 'queued')

    await adminDb`
      INSERT INTO email_sends (campaign_id, client_id, email, status)
      SELECT * FROM unnest(
        ${adminDb.array(campaignIds)}::uuid[],
        ${adminDb.array(clientIds)}::uuid[],
        ${adminDb.array(emails)}::text[],
        ${adminDb.array(statuses)}::text[]
      ) AS t(campaign_id, client_id, email, status)
      ON CONFLICT DO NOTHING
    `

    // Fetch the inserted send IDs so we can embed them in job payloads (for unsubscribe links)
    const sendRows = await adminDb<{ id: string; email: string }[]>`
      SELECT id, email FROM email_sends WHERE campaign_id = ${campaignId}
    `
    const sendIdByEmail = new Map(sendRows.map(r => [r.email, r.id]))

    // Enqueue one job per contact with sendId included
    const queue = getCampaignQueue()
    for (const c of contacts) {
      const email = c.email.toLowerCase()
      await queue.add('send-email', {
        campaignId,
        email,
        sendId:    sendIdByEmail.get(email) ?? null,
        firstName: c.first_name,
        lastName:  c.last_name,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    }
    await queue.close()
  }

  log.info({ campaignId, queued: contacts.length }, 'Campaign launched')
  return { queued: contacts.length }
}

// ── Handle Postal webhook event ───────────────────────────────

type PostalEvent = 'MessageDelivered' | 'MessageBounced' | 'MessageDelayedBounce' | 'SpamComplaint' | 'MessageLinkClicked'

interface PostalWebhookPayload {
  event: PostalEvent
  payload: {
    message?: { id: string; token: string }
    original_message?: { id: string; token: string }
    email?: string
    status?: string
    url?: string
  }
}

export async function handlePostalEvent(raw: PostalWebhookPayload): Promise<void> {
  const msgId = raw.payload.message?.id ?? raw.payload.original_message?.id
  if (!msgId) return

  // Store raw event
  await adminDb`
    INSERT INTO email_postal_events (postal_message_id, event_type, payload)
    VALUES (${String(msgId)}, ${raw.event}, ${JSON.stringify(raw.payload)}::jsonb)
  `

  // Update the send record
  if (raw.event === 'MessageDelivered') {
    await adminDb`
      UPDATE email_sends
      SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
      WHERE postal_message_id = ${String(msgId)}
    `
    await incrementCampaignStat(String(msgId), 'total_delivered')
  }

  if (raw.event === 'MessageBounced' || raw.event === 'MessageDelayedBounce') {
    const email = raw.payload.email
    await adminDb`
      UPDATE email_sends
      SET status = 'bounced', bounced_at = NOW(), updated_at = NOW()
      WHERE postal_message_id = ${String(msgId)}
    `
    await incrementCampaignStat(String(msgId), 'total_bounced')

    // Auto-suppress hard bounces globally
    if (email) {
      await adminDb`
        INSERT INTO email_suppressions (email, reason, client_id)
        VALUES (${email.toLowerCase()}, 'bounce', NULL)
        ON CONFLICT DO NOTHING
      `
    }
  }

  if (raw.event === 'SpamComplaint') {
    const email = raw.payload.email
    await adminDb`
      UPDATE email_sends
      SET status = 'complained', updated_at = NOW()
      WHERE postal_message_id = ${String(msgId)}
    `
    await incrementCampaignStat(String(msgId), 'total_complained')

    if (email) {
      await adminDb`
        INSERT INTO email_suppressions (email, reason, client_id)
        VALUES (${email.toLowerCase()}, 'complaint', NULL)
        ON CONFLICT DO NOTHING
      `
    }
  }

  if (raw.event === 'MessageLinkClicked') {
    await adminDb`
      UPDATE email_sends
      SET clicked_at = COALESCE(clicked_at, NOW()), updated_at = NOW()
      WHERE postal_message_id = ${String(msgId)}
    `
    await incrementCampaignStat(String(msgId), 'total_clicked')
  }
}

async function incrementCampaignStat(postalMessageId: string, column: string): Promise<void> {
  // Find campaign_id from the send record
  const [send] = await adminDb<{ campaign_id: string }[]>`
    SELECT campaign_id FROM email_sends WHERE postal_message_id = ${postalMessageId} LIMIT 1
  `
  if (!send) return

  await adminDb`
    UPDATE email_campaigns
    SET ${adminDb.unsafe(column)} = ${adminDb.unsafe(column)} + 1, updated_at = NOW()
    WHERE id = ${send.campaign_id}
  `
}

// Fire scheduled campaigns whose scheduled_at has passed
export async function fireScheduledCampaigns(): Promise<void> {
  const due = await adminDb<{ id: string }[]>`
    SELECT id FROM email_campaigns
    WHERE status = 'scheduled' AND scheduled_at <= NOW()
  `
  for (const { id } of due) {
    log.info({ campaignId: id }, 'Auto-firing scheduled campaign')
    await launchCampaign(id).catch(err =>
      log.error({ campaignId: id, err }, 'Failed to auto-fire scheduled campaign')
    )
  }
}

// Check if all sends are done using the campaign's own counters — no full table scan.
// Called after each job completes; completes the campaign when sent+bounced+failed = total.
export async function maybeCompleteCampaign(campaignId: string): Promise<void> {
  await adminDb`
    UPDATE email_campaigns
    SET status = 'sent', completed_at = NOW(), updated_at = NOW()
    WHERE id            = ${campaignId}
      AND status        = 'sending'
      AND total_recipients > 0
      AND (total_sent + total_bounced + total_complained) >= total_recipients
  `
}
