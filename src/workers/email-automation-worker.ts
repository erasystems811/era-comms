// ── EMAIL AUTOMATION WORKER ───────────────────────────────────
//
// Polls every 60s for enrollments whose next_step_at has passed.
// For each due enrollment: executes the current step (send email or
// advance past a wait), then schedules the next step.

import { adminDb }        from '../db/client.js'
import { logger }         from '../shared/logger.js'
import { postalSend }     from '../services/postal.js'
import { sendEmail }      from '../shared/email.js'
import { isSuppressed }   from '../services/email-campaigns.js'
import { config }         from '../shared/config.js'

const log = logger.child({ component: 'email-automation-worker' })

type Enrollment = {
  id:           string
  flow_id:      string
  client_id:    string
  email:        string
  first_name:   string | null
  last_name:    string | null
  current_step: number
  status:       string
}

type Step = {
  id:            string
  flow_id:       string
  step_index:    number
  step_type:     'send_email' | 'wait'
  template_id:   string | null
  domain_id:     string | null
  from_name:     string | null
  from_email:    string | null
  delay_minutes: number
}

async function processDueEnrollments(): Promise<void> {
  const due = await adminDb<Enrollment[]>`
    SELECT e.id, e.flow_id, e.client_id, e.email,
           e.first_name, e.last_name, e.current_step, e.status
    FROM email_automation_enrollments e
    WHERE e.status = 'active' AND e.next_step_at <= NOW()
    LIMIT 100
  `

  for (const enrollment of due) {
    await processStep(enrollment).catch(err =>
      log.error({ enrollmentId: enrollment.id, err }, 'Enrollment step failed')
    )
  }
}

async function processStep(e: Enrollment): Promise<void> {
  const [step] = await adminDb<Step[]>`
    SELECT * FROM email_automation_steps
    WHERE flow_id = ${e.flow_id} AND step_index = ${e.current_step}
  `

  if (!step) {
    // No more steps — mark completed
    await adminDb`
      UPDATE email_automation_enrollments
      SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE id = ${e.id}
    `
    await adminDb`
      UPDATE email_automation_flows
      SET total_completed = total_completed + 1, updated_at = NOW()
      WHERE id = ${e.flow_id}
    `
    return
  }

  const nextStepDelay = step.delay_minutes

  if (step.step_type === 'send_email') {
    // Suppression check
    const suppressed = await isSuppressed(e.email, e.client_id)
    if (!suppressed && step.template_id) {
      await sendAutomationEmail(e, step)
    }
  }
  // For 'wait' steps: no action, just advance and apply the delay

  // Peek at next step to know if there's more work
  const [nextStep] = await adminDb<{ step_index: number }[]>`
    SELECT step_index FROM email_automation_steps
    WHERE flow_id = ${e.flow_id} AND step_index = ${e.current_step + 1}
  `

  if (!nextStep) {
    // This was the last step — complete after sending
    if (step.step_type === 'wait' || nextStepDelay === 0) {
      await adminDb`
        UPDATE email_automation_enrollments
        SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = ${e.id}
      `
      await adminDb`
        UPDATE email_automation_flows
        SET total_completed = total_completed + 1, updated_at = NOW()
        WHERE id = ${e.flow_id}
      `
      return
    }
  }

  await adminDb`
    UPDATE email_automation_enrollments
    SET current_step = ${e.current_step + 1},
        next_step_at = NOW() + (${nextStepDelay} * INTERVAL '1 minute'),
        updated_at   = NOW()
    WHERE id = ${e.id}
  `
}

async function sendAutomationEmail(e: Enrollment, step: Step): Promise<void> {
  if (!step.template_id) return

  const [tpl] = await adminDb<{ subject: string; html_body: string }[]>`
    SELECT subject, html_body FROM email_templates WHERE id = ${step.template_id}
  `
  if (!tpl) return

  const fromName  = step.from_name  ?? 'ERA Comms'
  const fromEmail = step.from_email ?? config.email.from

  const name = e.first_name ?? (e.email.split('@')[0] ?? e.email)
  let html   = tpl.html_body
    .replace(/\{\{first_name\}\}/gi, name)
    .replace(/\{\{email\}\}/gi, e.email)

  const subject = tpl.subject.replace(/\{\{first_name\}\}/gi, name)

  // Inject unsubscribe block (automation enrollments don't have a send_id, use enrollment id)
  const unsubUrl = `${config.publicUrl}/v1/email/unsubscribe?eid=${e.id}`
  const unsubBlock = `<div style="text-align:center;padding:24px 0 8px;font-family:sans-serif;font-size:11px;color:#888">
    <a href="${unsubUrl}" style="color:#888;text-decoration:underline">Unsubscribe</a>
  </div>`
  html = html.includes('</body>')
    ? html.replace('</body>', `${unsubBlock}</body>`)
    : html + unsubBlock

  const postalResult = await postalSend({
    to:              [e.email],
    from:            `${fromName} <${fromEmail}>`,
    subject,
    htmlBody:        html,
    tag:             `automation_${e.flow_id}`,
    listUnsubscribe: unsubUrl,
  })

  // Record the send
  await adminDb`
    INSERT INTO email_automation_sends (enrollment_id, step_index, email, postal_message_id, status)
    VALUES (${e.id}, ${step.step_index}, ${e.email}, ${postalResult?.messageId ?? null}, 'sent')
  `

  if (!postalResult) {
    // Postal not configured — fallback to SMTP
    await sendEmail({ to: e.email, subject, html })
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null

export function startEmailAutomationWorker(): { stop: () => void } {
  processDueEnrollments().catch(err =>
    log.error({ err }, 'Initial email automation poll failed')
  )

  pollInterval = setInterval(() => {
    processDueEnrollments().catch(err =>
      log.error({ err }, 'Email automation poll failed')
    )
  }, 60_000)

  log.info('Email automation worker started')
  return {
    stop: () => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
    },
  }
}
