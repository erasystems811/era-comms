// ── EMAIL CAMPAIGN WORKER ─────────────────────────────────────
//
// Consumes the email_campaign queue. Pulls template + domain config,
// personalises the HTML, sends via Postal API, records the Postal
// message ID back onto the email_sends row.
//
// Rate: BullMQ limiter caps at 50 sends/second to stay within Postal
// server limits. Adjust POSTAL_RATE_LIMIT env var to override.

import { Worker, type Job } from 'bullmq'
import { adminDb }          from '../db/client.js'
import { logger }           from '../shared/logger.js'
import { postalSend }       from '../services/postal.js'
import { sendEmail }        from '../shared/email.js'
import { maybeCompleteCampaign } from '../services/email-campaigns.js'
import { QUEUE }            from '../queues/definitions.js'
import { config }           from '../shared/config.js'

const log = logger.child({ component: 'email-campaign-worker' })

export interface EmailCampaignJob {
  campaignId: string
  email:      string
  firstName:  string | null
  lastName:   string | null
}

async function processCampaignJob(job: Job<EmailCampaignJob>): Promise<void> {
  const { campaignId, email, firstName } = job.data

  // Load campaign + template + domain in one query
  const [row] = await adminDb<{
    campaign_name: string
    client_id:     string
    template_html: string
    subject:       string
    from_name:     string
    from_email:    string
    domain:        string
  }[]>`
    SELECT
      c.name            AS campaign_name,
      c.client_id,
      t.html_body       AS template_html,
      t.subject,
      c.from_name,
      c.from_email,
      d.domain
    FROM email_campaigns c
    JOIN email_templates t  ON t.id = c.template_id
    JOIN email_domains   d  ON d.id = c.domain_id
    WHERE c.id = ${campaignId}
  `

  if (!row) {
    log.warn({ campaignId }, 'Campaign not found — skipping job')
    return
  }

  // Basic personalisation — replace {{first_name}} etc.
  const name = firstName ?? (email.split('@')[0] ?? email)
  const html = row.template_html
    .replace(/\{\{first_name\}\}/gi, name)
    .replace(/\{\{email\}\}/gi, email)

  const subject = row.subject
    .replace(/\{\{first_name\}\}/gi, name)

  // Try Postal first (high-volume, dedicated IP). Fall back to SMTP when Postal isn't set up yet.
  let sent = false
  let postalMessageId: string | null = null

  const postalResult = await postalSend({
    to:       [email],
    from:     `${row.from_name} <${row.from_email}>`,
    subject,
    htmlBody: html,
    tag:      campaignId,
  })

  if (postalResult) {
    sent = true
    postalMessageId = postalResult.messageId
  } else {
    // Postal not configured — fall back to SMTP
    sent = await sendEmail({ to: email, subject, html })
  }

  await adminDb`
    UPDATE email_sends
    SET
      postal_message_id = ${postalMessageId},
      status            = ${sent ? 'sent' : 'failed'},
      updated_at        = NOW()
    WHERE campaign_id = ${campaignId}
      AND email       = ${email}
  `

  if (sent) {
    await adminDb`
      UPDATE email_campaigns
      SET total_sent = total_sent + 1, updated_at = NOW()
      WHERE id = ${campaignId}
    `
  }

  // Check if campaign is fully complete
  await maybeCompleteCampaign(campaignId)

  log.debug({ campaignId, email, postalId: postalMessageId, via: postalMessageId ? 'postal' : 'smtp' }, 'Email send job done')
}

export function startEmailCampaignWorker(): Worker {
  const rateLimit = Number(config.email.postalRateLimit ?? 50)

  const worker = new Worker<EmailCampaignJob>(
    QUEUE.emailCampaign,
    processCampaignJob,
    {
      connection: { url: config.redis.url },
      concurrency: 10,
      limiter: {
        max:      rateLimit,
        duration: 1000,  // per second
      },
    },
  )

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Email campaign job failed')
  })

  log.info({ rateLimit }, 'Email campaign worker started')
  return worker
}
