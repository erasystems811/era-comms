import { postalSend } from '../services/postal.js'
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
  const result = await postalSend({
    to:       [opts.to],
    from:     `ERA Systems <${config.email.from}>`,
    subject:  opts.subject,
    htmlBody: opts.html,
    textBody: opts.text,
    tag:      'transactional',
  })

  if (!result) {
    log.warn({ to: opts.to, subject: opts.subject }, 'Transactional email skipped — Postal not configured or send failed')
    return false
  }

  log.info({ to: opts.to, subject: opts.subject, messageId: result.messageId }, 'Transactional email sent via Postal')
  return true
}

// ── Pre-built templates ───────────────────────────────────────

export function portalAccessEmail(opts: {
  businessName: string
  email: string
  portalUrl: string
  tempPassword: string
}): EmailOptions {
  const { businessName, email, portalUrl, tempPassword } = opts
  return {
    to:      email,
    subject: `Your ERA Comms Business Portal is ready`,
    text:    `Hi ${businessName},\n\nYour ERA Comms account has been approved.\n\nLogin at: ${portalUrl}/biz/login\nEmail: ${email}\nTemporary password: ${tempPassword}\n\nChange your password immediately after your first login.\n\nERA Systems`,
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

      <div style="background:#1a1729;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:16px">
        <p style="margin:0 0 12px;font-size:13px;color:#8b8a9b;font-weight:600;text-transform:uppercase;letter-spacing:0.1em">Your login details</p>
        <p style="margin:0 0 6px;font-size:14px;color:#e2e0ef"><strong>Portal:</strong> <a href="${portalUrl}/biz/login" style="color:#bf7c93">${portalUrl}/biz/login</a></p>
        <p style="margin:0 0 6px;font-size:14px;color:#e2e0ef"><strong>Email:</strong> ${email}</p>
        <p style="margin:0;font-size:14px;color:#e2e0ef"><strong>Password:</strong> <span style="font-family:monospace;background:#0f0d17;padding:2px 8px;border-radius:4px;color:#bf7c93">${tempPassword}</span></p>
      </div>

      <div style="background:rgba(239,200,100,0.07);border:1px solid rgba(239,200,100,0.15);border-radius:12px;padding:16px;margin-bottom:28px">
        <p style="margin:0;font-size:13px;color:#d4a430">Change your password immediately after your first login.</p>
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
  revealUrl: string
  keyLabel: string
}): EmailOptions {
  const { businessName, revealUrl, keyLabel } = opts
  return {
    to:      opts.email,
    subject: `Your ERA Comms API key is ready`,
    text:    `Hi ${businessName},\n\nYour API key "${keyLabel}" is ready.\n\nClick the link below to view it. This link works once and expires in 7 days:\n\n${revealUrl}\n\nERA Systems`,
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
      <p style="color:#8b8a9b;margin:0 0 24px">An API key <strong style="color:#e2e0ef">"${keyLabel}"</strong> has been generated for <strong style="color:#e2e0ef">${businessName}</strong>.</p>

      <div style="background:#1a1729;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px">
        <p style="margin:0 0 8px;font-size:13px;color:#8b8a9b">Click the button below to reveal your key. <strong style="color:#e2e0ef">This link works only once</strong> and expires in 7 days.</p>
        <p style="margin:0;font-size:12px;color:#4a4958">Keep your key safe — do not share it publicly.</p>
      </div>

      <a href="${revealUrl}" style="display:inline-block;background:#bf7c93;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:14px">Reveal my API key</a>

      <p style="margin:32px 0 0;font-size:12px;color:#4a4958">ERA Systems · If you did not expect this email, ignore it — your account is safe.</p>
    </td></tr>
  </table>
</body>
</html>`,
  }
}
