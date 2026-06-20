import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { adminDb, withClient } from '../db/client.js'
import { config } from '../shared/config.js'
import { NotFoundError, SessionError } from '../shared/errors.js'
import { QUEUE } from '../queues/definitions.js'
import type { OutboundMessageJob } from '../queues/definitions.js'

// ── PROFILE PROVISIONING ──────────────────────────────────────
//
// Lazily provisions a communication profile and first version for a client
// on their first message send. Uses the category default from
// default_communication_profiles, falling back to 'general'.
// Idempotent — safe to call concurrently (ON CONFLICT handles races).

type DefaultProfile = {
  persona: string
  tone: string
  permitted_topics: string[]
  prohibited_topics: string[]
  escalation_triggers: string[]
  system_prompt: string
}

export async function getOrProvisionProfileVersion(clientId: string): Promise<string> {
  const existing = (await adminDb`
    SELECT current_version_id FROM communication_profiles WHERE client_id = ${clientId}
  `) as unknown as Array<{ current_version_id: string | null }>

  if (existing[0]?.current_version_id) return existing[0].current_version_id

  return adminDb.begin(async (tx) => {
    // Try category default, fall back to 'general'
    let defaults = (await tx`
      SELECT dcp.persona, dcp.tone, dcp.permitted_topics,
             dcp.prohibited_topics, dcp.escalation_triggers, dcp.system_prompt
      FROM   default_communication_profiles dcp
      JOIN   clients c ON c.category_id = dcp.category_id
      WHERE  c.id = ${clientId}
    `) as unknown as DefaultProfile[]

    if (!defaults[0]) {
      defaults = (await tx`
        SELECT dcp.persona, dcp.tone, dcp.permitted_topics,
               dcp.prohibited_topics, dcp.escalation_triggers, dcp.system_prompt
        FROM   default_communication_profiles dcp
        JOIN   business_categories bc ON bc.id = dcp.category_id
        WHERE  bc.slug = 'general'
      `) as unknown as DefaultProfile[]
    }

    const dp = defaults[0]
    if (!dp) throw new Error('No default communication profile found')

    // Upsert communication_profiles row
    const cpRows = (await tx`
      INSERT INTO communication_profiles (client_id)
      VALUES (${clientId})
      ON CONFLICT (client_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, current_version_id
    `) as unknown as Array<{ id: string; current_version_id: string | null }>

    const cp = cpRows[0]!
    if (cp.current_version_id) return cp.current_version_id // Race: already provisioned

    // Insert first version
    const vRows = (await tx`
      INSERT INTO communication_profile_versions (
        profile_id, client_id, version_number,
        persona, tone, permitted_topics, prohibited_topics,
        escalation_triggers, system_prompt, created_by
      ) VALUES (
        ${cp.id}, ${clientId}, 1,
        ${dp.persona}, ${dp.tone},
        ${dp.permitted_topics}, ${dp.prohibited_topics},
        ${dp.escalation_triggers}, ${dp.system_prompt},
        'system'
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>

    const versionId = vRows[0]!.id

    await tx`
      UPDATE communication_profiles SET current_version_id = ${versionId} WHERE id = ${cp.id}
    `

    return versionId
  }) as Promise<string>
}

// ── SEND MESSAGE ──────────────────────────────────────────────

export interface SendMessageOptions {
  clientId: string
  sessionId: string
  to: string               // E.164 recipient
  content: string
  contentType?: 'text' | 'image' | 'audio' | 'video' | 'document'
  conversationId?: string  // Pin to existing conversation, or find/create
  idempotencyKey?: string  // Client-supplied. Auto-generated if omitted.
}

export interface SendMessageResult {
  messageId: string
  conversationId: string
  status: 'queued'
  idempotent: boolean // true if the idempotency key matched an existing message
}

export async function sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
  const {
    clientId,
    sessionId,
    to,
    content,
    contentType = 'text',
    conversationId: requestedConvId,
    idempotencyKey,
  } = opts

  const ikey = idempotencyKey ?? randomUUID()

  // Provision profile version before the main transaction (idempotent, separate tx)
  const profileVersionId = await getOrProvisionProfileVersion(clientId)

  const result = await withClient(clientId, async (tx) => {
    // Idempotency check — return the original result if this key was already used
    if (idempotencyKey) {
      const prev = (await tx`
        SELECT id, conversation_id FROM messages
        WHERE client_id = ${clientId} AND idempotency_key = ${idempotencyKey}
      `) as unknown as Array<{ id: string; conversation_id: string }>

      if (prev[0]) {
        return {
          messageId: prev[0].id,
          conversationId: prev[0].conversation_id,
          status: 'queued' as const,
          idempotent: true,
        }
      }
    }

    // Verify session belongs to client and is sendable
    const sessions = (await tx`
      SELECT id, status FROM whatsapp_sessions WHERE id = ${sessionId}
    `) as unknown as Array<{ id: string; status: string }>

    const sess = sessions[0]
    if (!sess) throw new NotFoundError('Session')
    if (sess.status === 'banned') {
      throw new SessionError('Session is permanently banned — replace the number')
    }

    // Find or create contact (upsert on unique(client_id, phone_number))
    const contactRows = (await tx`
      INSERT INTO contacts (client_id, phone_number)
      VALUES (${clientId}, ${to})
      ON CONFLICT (client_id, phone_number) DO UPDATE
        SET last_contacted_at = NOW(),
            updated_at        = NOW()
      RETURNING id
    `) as unknown as Array<{ id: string }>

    const contactId: string = contactRows[0]!.id

    // Find or create conversation
    let convId: string

    if (requestedConvId) {
      const convs = (await tx`
        SELECT id FROM conversations WHERE id = ${requestedConvId} AND status != 'closed'
      `) as unknown as Array<{ id: string }>
      if (!convs[0]) throw new NotFoundError('Conversation')
      convId = convs[0].id
    } else {
      const convs = (await tx`
        SELECT id FROM conversations
        WHERE contact_id = ${contactId}
          AND session_id = ${sessionId}
          AND status     = 'active'
        ORDER BY created_at DESC LIMIT 1
      `) as unknown as Array<{ id: string }>

      if (convs[0]) {
        convId = convs[0].id
      } else {
        const newConv = (await tx`
          INSERT INTO conversations (
            client_id, contact_id, session_id, profile_version_id, status, ai_active
          ) VALUES (
            ${clientId}, ${contactId}, ${sessionId}, ${profileVersionId}, 'active', TRUE
          )
          RETURNING id
        `) as unknown as Array<{ id: string }>
        convId = newConv[0]!.id
      }
    }

    // Insert message record
    const msgRows = (await tx`
      INSERT INTO messages (
        conversation_id, client_id, session_id,
        direction, content, content_type,
        idempotency_key, status, warmup_stage
      ) VALUES (
        ${convId}, ${clientId}, ${sessionId},
        'outbound', ${content}, ${contentType},
        ${ikey}, 'queued', 'unrestricted'
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>

    return {
      messageId: msgRows[0]!.id,
      conversationId: convId,
      status: 'queued' as const,
      idempotent: false,
    }
  })

  // Enqueue AFTER the transaction commits — the worker reads the message record
  if (!result.idempotent) {
    const queue = new Queue<OutboundMessageJob>(QUEUE.outbound(sessionId), {
      connection: { url: config.redis.url },
    })
    await queue.add(
      'outbound',
      {
        messageId: result.messageId,
        clientId,
        sessionId,
        to,
        content,
        contentType,
        conversationId: result.conversationId,
        aiGenerated: false,
      },
      { removeOnComplete: true, removeOnFail: 100 },
    )
  }

  return result
}

