// ── POSTAL HTTP CLIENT ────────────────────────────────────────
//
// Thin wrapper around the Postal REST API.
// All methods return null / false when POSTAL_API_KEY is not configured
// so the email module degrades gracefully until the VPS is online.

import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ component: 'postal' })

export interface PostalSendResult {
  messageId: string   // Postal's internal message ID
  token: string       // per-message tracking token
}

export interface PostalSendOptions {
  to: string[]
  from: string        // "Name <email@domain.com>"
  replyTo?: string
  subject: string
  htmlBody: string
  textBody?: string
  tag?: string        // campaign ID for grouping in Postal UI
}

export interface PostalDomainRecord {
  spfRecord: string
  dkimRecord: { name: string; value: string }
  dmarcRecord: string
  mxRecord: string
}

function postalHeaders() {
  return {
    'X-Server-API-Key': config.email.postalApiKey ?? '',
    'Content-Type': 'application/json',
  }
}

function postalUrl(path: string) {
  return `${config.email.postalServerUrl}/api/v1/${path}`
}

function isConfigured(): boolean {
  return !!(config.email.postalApiKey && config.email.postalServerUrl)
}

// Send a single email. Returns null if Postal is not configured.
export async function postalSend(opts: PostalSendOptions): Promise<PostalSendResult | null> {
  if (!isConfigured()) {
    log.warn({ to: opts.to }, 'Postal not configured — email skipped')
    return null
  }

  try {
    const res = await fetch(postalUrl('send/message'), {
      method: 'POST',
      headers: postalHeaders(),
      body: JSON.stringify({
        to:        opts.to,
        from:      opts.from,
        reply_to:  opts.replyTo,
        subject:   opts.subject,
        html_body: opts.htmlBody,
        plain_body: opts.textBody,
        tag:        opts.tag,
        track_clicks: true,
        track_opens:  false, // pixel tracking disabled — click-first principle
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      log.error({ status: res.status, body, to: opts.to }, 'Postal API error')
      return null
    }

    const data = await res.json() as {
      status: string
      data?: { message_id?: string; messages?: Record<string, { id: string; token: string }> }
    }

    if (data.status !== 'success') {
      log.error({ data, to: opts.to }, 'Postal returned non-success')
      return null
    }

    // Extract first message ID from the response
    const messages = data.data?.messages ?? {}
    const firstKey = Object.keys(messages)[0]
    const msg      = firstKey ? messages[firstKey] : null

    return msg ? { messageId: String(msg.id), token: msg.token } : null
  } catch (err) {
    log.error({ err, to: opts.to }, 'Postal send threw')
    return null
  }
}

// Verify that Postal connectivity works. Used in the email overview health check.
export async function postalPing(): Promise<boolean> {
  if (!isConfigured()) return false
  try {
    const res = await fetch(postalUrl('servers/list'), {
      headers: postalHeaders(),
    })
    return res.ok
  } catch {
    return false
  }
}

// DNS records the client must add at their registrar for full deliverability.
// These are static based on the ERA Comms Postal server hostname.
export function postalDnsRecords(domain: string, dkimPublicKey: string | null): PostalDomainRecord {
  const postalHost = config.email.postalServerUrl
    ? new URL(config.email.postalServerUrl).hostname
    : 'mail.erasystems.io'

  return {
    spfRecord:   `v=spf1 a mx include:${postalHost} ~all`,
    dkimRecord:  {
      name:  `era-comms._domainkey.${domain}`,
      value: dkimPublicKey ?? '(pending — verify domain in Postal first)',
    },
    dmarcRecord: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${postalHost}`,
    mxRecord:    `10 ${postalHost}`,
  }
}
