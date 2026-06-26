// ── AUTOMATION SEQUENCE WORKER ────────────────────────────────
//
// Polls every 60s for automation_enrollments where next_step_at <= NOW().
// For each due enrollment, processes the next step (send_message or wait),
// then schedules the following step.

import { adminDb } from '../db/client.js'
import { logger } from '../shared/logger.js'
import { sendMessage } from '../services/messaging.js'

const log = logger.child({ component: 'automation-worker' })

type EnrollmentRow = {
  id:           string
  flow_id:      string
  client_id:    string
  phone_number: string
  name:         string | null
  current_step: number
}

type StepRow = {
  id:            string
  step_order:    number
  step_type:     'send_message' | 'wait'
  content:       string | null
  content_type:  string
  delay_minutes: number
}

type FlowRow = {
  session_id: string
  status:     string
}

async function processDueEnrollments(): Promise<void> {
  // Load all active enrollments that are due
  const enrollments = (await adminDb`
    SELECT id, flow_id, client_id, phone_number, name, current_step
    FROM   automation_enrollments
    WHERE  status       = 'active'
      AND  next_step_at <= NOW()
    LIMIT 50
  `) as unknown as EnrollmentRow[]

  if (enrollments.length === 0) return

  log.debug({ count: enrollments.length }, 'Processing due automation enrollments')

  for (const enrollment of enrollments) {
    try {
      // Load flow
      const flows = (await adminDb`
        SELECT session_id, status FROM automation_flows WHERE id = ${enrollment.flow_id}
      `) as unknown as FlowRow[]

      const flow = flows[0]
      if (!flow || flow.status !== 'active') {
        // Flow paused or archived — cancel enrollment
        await adminDb`
          UPDATE automation_enrollments SET status = 'cancelled', updated_at = NOW() WHERE id = ${enrollment.id}
        `
        continue
      }

      // Load the current step
      const steps = (await adminDb`
        SELECT id, step_order, step_type, content, content_type, delay_minutes
        FROM   automation_steps
        WHERE  flow_id = ${enrollment.flow_id}
        ORDER BY step_order ASC
      `) as unknown as StepRow[]

      const currentStep = steps[enrollment.current_step]

      if (!currentStep) {
        // No more steps — enrollment complete
        await adminDb`
          UPDATE automation_enrollments
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = ${enrollment.id}
        `
        await adminDb`
          UPDATE automation_flows
          SET total_completed = total_completed + 1, updated_at = NOW()
          WHERE id = ${enrollment.flow_id}
        `
        continue
      }

      if (currentStep.step_type === 'send_message' && currentStep.content) {
        // Send the message
        await sendMessage({
          clientId:       enrollment.client_id,
          sessionId:      flow.session_id,
          to:             enrollment.phone_number,
          content:        currentStep.content,
          contentType:    (currentStep.content_type as 'text') ?? 'text',
          idempotencyKey: `automation_${enrollment.id}_step_${currentStep.step_order}`,
        })
      }
      // 'wait' steps do nothing — just advance the pointer

      // Advance to next step
      const nextStepIndex = enrollment.current_step + 1
      const nextStep      = steps[nextStepIndex]

      if (!nextStep) {
        // This was the last step
        await adminDb`
          UPDATE automation_enrollments
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = ${enrollment.id}
        `
        await adminDb`
          UPDATE automation_flows
          SET total_completed = total_completed + 1, updated_at = NOW()
          WHERE id = ${enrollment.flow_id}
        `
      } else {
        // Schedule next step
        const nextAt = new Date(Date.now() + nextStep.delay_minutes * 60 * 1000)
        await adminDb`
          UPDATE automation_enrollments
          SET current_step = ${nextStepIndex},
              next_step_at = ${nextAt.toISOString()},
              updated_at   = NOW()
          WHERE id = ${enrollment.id}
        `
      }
    } catch (err) {
      log.error({ enrollmentId: enrollment.id, err }, 'Failed to process automation enrollment')
      // Don't crash the poller — skip this enrollment and try again next tick
    }
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null

export function startAutomationWorker(): { stop: () => void } {
  log.info('Automation sequence worker started (polling every 60s)')

  // Run immediately on start, then every 60s
  void processDueEnrollments().catch((err: unknown) => log.error({ err }, 'Automation poll error'))

  pollInterval = setInterval(() => {
    processDueEnrollments().catch((err: unknown) => log.error({ err }, 'Automation poll error'))
  }, 60_000)

  return {
    stop: () => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
      log.info('Automation sequence worker stopped')
    },
  }
}
