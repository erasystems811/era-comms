// ── OPERATOR SELF-ALERTING ─────────────────────────────────────
//
// Sends WhatsApp messages to the operator's alert number when
// ERA Comms detects a critical event (session ban, queue spike, etc.).
//
// Finds any healthy primary session, then writes a message record and
// enqueues it directly to that session's outbound BullMQ queue,
// bypassing plan limits and warmup caps.
// If no session is available, falls back to logger.error only.

import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { adminDb, withClient } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { QUEUE } from '../queues/definitions.js'
import type { OutboundMessageJob } from '../queues/definitions.js'

const alertLog = logger.child({ component: 'alerts' })

type SessionRow = { id: string; client_id: string }

export async function sendOperatorAlert(message: string): Promise<void> {
  const alertNumber = config.monitoring.alertWhatsappNumber

  alertLog.error({ alertNumber, message }, 'OPERATOR ALERT')

  // Find any healthy primary session to route through
  const rows = (await adminDb`
    SELECT id, client_id
    FROM   whatsapp_sessions
    WHERE  status = 'active'
      AND  role   = 'primary'
    ORDER BY last_heartbeat_at DESC NULLS LAST
    LIMIT 1
  `) as unknown as SessionRow[]

  const session = rows[0]
  if (!session) {
    alertLog.warn('No active session available to send operator alert via WhatsApp')
    return
  }

  const messageId = randomUUID()

  // Returns the conversation ID on success, null if no profile is configured yet
  const convId = await withClient(session.client_id, async (tx): Promise<string | null> => {
    // Find or create the alert contact
    const contactRows = (await tx`
      INSERT INTO contacts (client_id, phone_number, display_name)
      VALUES (${session.client_id}, ${alertNumber}, 'ERA Systems Operator')
      ON CONFLICT (client_id, phone_number) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `) as unknown as Array<{ id: string }>
    const contactId: string = contactRows[0]!.id

    // Reuse an existing active alert conversation for this contact
    const existingConvRows = (await tx`
      SELECT id FROM conversations
      WHERE  contact_id = ${contactId}
        AND  session_id = ${session.id}
        AND  status     = 'active'
      LIMIT 1
    `) as unknown as Array<{ id: string }>

    let resolvedConvId: string

    if (existingConvRows[0]) {
      resolvedConvId = existingConvRows[0].id
    } else {
      const profRows = (await tx`
        SELECT current_version_id FROM communication_profiles WHERE client_id = ${session.client_id}
      `) as unknown as Array<{ current_version_id: string | null }>
      const profileVersionId = profRows[0]?.current_version_id ?? null

      if (!profileVersionId) {
        alertLog.warn('No profile version for operator client — skipping WhatsApp alert')
        return null
      }

      const newConv = (await tx`
        INSERT INTO conversations (
          client_id, contact_id, session_id, profile_version_id, status, ai_active
        ) VALUES (
          ${session.client_id}, ${contactId}, ${session.id}, ${profileVersionId},
          'active', FALSE
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>
      resolvedConvId = newConv[0]!.id
    }

    await tx`
      INSERT INTO messages (
        id, conversation_id, client_id, session_id,
        direction, content, content_type,
        idempotency_key, status, ai_generated
      ) VALUES (
        ${messageId}::uuid, ${resolvedConvId}, ${session.client_id}, ${session.id},
        'outbound', ${message}, 'text',
        ${messageId}, 'queued', FALSE
      )
    `

    return resolvedConvId
  })

  if (!convId) return // No profile — alert already logged

  // Enqueue directly — bypasses plan limits and warmup
  const q = new Queue<OutboundMessageJob>(QUEUE.outbound(session.id), {
    connection: { url: config.redis.url },
  })
  await q.add(
    'outbound',
    {
      messageId,
      clientId:       session.client_id,
      sessionId:      session.id,
      to:             alertNumber,
      content:        message,
      contentType:    'text',
      conversationId: convId,
      aiGenerated:    false,
    },
    { removeOnComplete: true, removeOnFail: 5 },
  )
  await q.close()

  alertLog.info({ sessionId: session.id }, 'Operator alert enqueued')
}
