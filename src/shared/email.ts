import { config } from './config.js'
import { logger } from './logger.js'

const log = logger.child({ component: 'email' })

export interface EmailOptions {
  to: string
  subject: string
  html: string
  text?: string
}

export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  const { postalServerUrl, postalApiKey, from } = config.email

  if (!postalServerUrl || !postalApiKey) {
    log.warn({ to: opts.to, subject: opts.subject }, 'Email skipped — Postal not configured (set POSTAL_SERVER_URL and POSTAL_API_KEY)')
    return false
  }

  try {
    const res = await fetch(`${postalServerUrl}/api/v1/send/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Server-API-Key': postalApiKey,
      },
      body: JSON.stringify({
        to:         [opts.to],
        from:       from,
        subject:    opts.subject,
        html_body:  opts.html,
        plain_body: opts.text ?? '',
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      log.error({ status: res.status, body, to: opts.to }, 'Postal delivery failed')
      return false
    }

    log.info({ to: opts.to, subject: opts.subject }, 'Email sent via Postal')
    return true
  } catch (err) {
    log.error({ err, to: opts.to }, 'Postal send threw')
    return false
  }
}

// ── Pre-built templates ───────────────────────────────────────

export function portalAccessEmail(opts: {
  businessName: string
  email: string
  portalUrl: string
}): EmailOptions {
  const { businessName, email, portalUrl } = opts
  return {
    to:      email,
    subject: `Your ERA Comms Business Portal is ready`,
    text:    `Hi ${businessName},\n\nYour ERA Comms account has been approved.\n\nLogin at: ${portalUrl}/biz/login\nEmail: ${email}\n\nContact your ERA Systems representative for your temporary password.\n\nERA Systems`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0d17;font-family:system-ui,-apple-system,sans-serif;color:#e2e0ef">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto">
    <tr><td style="padding:32px">
      <div style="margin-bottom:28px">
        <span style="font-size:22px;font-weight:700;color:#bf7c93">ERA</span>
        <span style="font-size:22px;font-weight:700;color:#e2e0ef"> Comms</span>
      </div>
      <h1 style="font-size:20px;font-weight:700;color:#e2e0ef;margin:0 0 8px">Your business portal is ready</h1>
      <p style="color:#8b8a9b;margin:0 0 24px">Your ERA Comms account for <strong style="color:#e2e0ef">${businessName}</strong> has been approved and is ready to use.</p>

      <div style="background:#1a1729;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px">
        <p style="margin:0 0 12px;font-size:13px;color:#8b8a9b;font-weight:600;text-transform:uppercase;letter-spacing:0.1em">Your login details</p>
        <p style="margin:0 0 6px;font-size:14px;color:#e2e0ef"><strong>Portal:</strong> <a href="${portalUrl}/biz/login" style="color:#bf7c93">${portalUrl}/biz/login</a></p>
        <p style="margin:0;font-size:14px;color:#e2e0ef"><strong>Email:</strong> ${email}</p>
      </div>

      <div style="background:rgba(239,200,100,0.07);border:1px solid rgba(239,200,100,0.15);border-radius:12px;padding:16px;margin-bottom:28px">
        <p style="margin:0;font-size:13px;color:#d4a430">Your temporary password will be provided by your ERA Systems representative. Change it immediately after first login.</p>
      </div>

      <a href="${portalUrl}/biz/login" style="display:inline-block;background:#bf7c93;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:14px">Open Business Portal</a>

      <p style="margin:32px 0 0;font-size:12px;color:#4a4958">ERA Systems · This email was sent because your account was recently approved.</p>
    </td></tr>
  </table>
</body>
</html>`,
  }
}

export function apiKeyEmail(opts: {
  businessName: string
  email: string
  portalUrl: string
  keyLabel: string
}): EmailOptions {
  const { businessName, email, portalUrl, keyLabel } = opts
  return {
    to:      email,
    subject: `ERA Comms API key ready — ${keyLabel}`,
    text:    `Hi ${businessName},\n\nAn API key "${keyLabel}" is ready for your account.\n\nLog in to your business portal to access your API keys: ${portalUrl}/biz/login\n\nERA Systems`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f0d17;font-family:system-ui,-apple-system,sans-serif;color:#e2e0ef">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto">
    <tr><td style="padding:32px">
      <div style="margin-bottom:28px">
        <span style="font-size:22px;font-weight:700;color:#bf7c93">ERA</span>
        <span style="font-size:22px;font-weight:700;color:#e2e0ef"> Comms</span>
      </div>
      <h1 style="font-size:20px;font-weight:700;color:#e2e0ef;margin:0 0 8px">Your API key is ready</h1>
      <p style="color:#8b8a9b;margin:0 0 24px">An API key <strong style="color:#e2e0ef">"${keyLabel}"</strong> has been created for your ERA Comms account.</p>

      <div style="background:#1a1729;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px">
        <p style="margin:0 0 6px;font-size:14px;color:#8b8a9b">Log in to your business portal to copy your API key and view integration guides.</p>
        <a href="${portalUrl}/biz/login" style="color:#bf7c93;font-size:14px">${portalUrl}/biz/login</a>
      </div>

      <a href="${portalUrl}/biz/login" style="display:inline-block;background:#bf7c93;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:14px">Go to Portal</a>

      <p style="margin:32px 0 0;font-size:12px;color:#4a4958">ERA Systems · If you didn't expect this, contact your ERA Systems representative.</p>
    </td></tr>
  </table>
</body>
</html>`,
  }
}
