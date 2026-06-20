import type { FastifyPluginAsync } from 'fastify'
import { withClient } from '../../db/client.js'
import { NotFoundError } from '../../shared/errors.js'
import { sendMessage } from '../../services/messaging.js'
import { assertScope } from '../middleware/auth.js'

const E164 = /^\+[1-9]\d{6,14}$/

const messagesRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /v1/messages — enqueue an outbound message ────────

  app.post('/', async (req, reply) => {
    assertScope(req, 'messaging')

    const body = req.body as {
      sessionId?: string
      to?: string
      content?: string
      contentType?: string
      conversationId?: string
      idempotencyKey?: string
    }

    if (!body.sessionId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'sessionId is required' })
    }
    if (!body.to || !E164.test(body.to)) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'to must be an E.164 phone number (e.g. +2348012345678)',
      })
    }
    if (!body.content?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'content is required' })
    }

    const result = await sendMessage({
      clientId:       req.clientId,
      sessionId:      body.sessionId,
      to:             body.to,
      content:        body.content,
      contentType:    'text',
      conversationId: body.conversationId,
      idempotencyKey: body.idempotencyKey,
    })

    return reply.status(result.idempotent ? 200 : 202).send({
      id:             result.messageId,
      conversationId: result.conversationId,
      status:         result.status,
      idempotent:     result.idempotent,
    })
  })

  // ── GET /v1/messages/:id — message status ──────────────────

  app.get('/:id', async (req, _reply) => {
    assertScope(req, 'messaging')
    const { id } = req.params as { id: string }

    type MsgRow = {
      id: string
      conversation_id: string
      direction: string
      content: string
      content_type: string
      status: string
      wa_message_id: string | null
      warmup_stage: string | null
      ai_generated: boolean
      created_at: string
      sent_at: string | null
    }

    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        SELECT id, conversation_id, direction, content, content_type,
               status, wa_message_id, warmup_stage, ai_generated,
               created_at, sent_at
        FROM messages
        WHERE id = ${id}
      `) as unknown as MsgRow[]
    })

    const msg = rows[0]
    if (!msg) throw new NotFoundError('Message')

    return {
      id:             msg.id,
      conversationId: msg.conversation_id,
      direction:      msg.direction,
      content:        msg.content,
      contentType:    msg.content_type,
      status:         msg.status,
      waMessageId:    msg.wa_message_id,
      warmupStage:    msg.warmup_stage,
      aiGenerated:    msg.ai_generated,
      createdAt:      msg.created_at,
      sentAt:         msg.sent_at,
    }
  })

  // ── GET /v1/conversations — list conversations ──────────────

  app.get('/conversations', async (req, _reply) => {
    assertScope(req, 'messaging')

    const { limit = '50', cursor } = req.query as Record<string, string | undefined>
    const take = Math.min(parseInt(limit, 10) || 50, 200)

    type ConvRow = {
      id: string
      contact_id: string
      session_id: string
      status: string
      ai_active: boolean
      total_turns: number
      created_at: string
      updated_at: string
    }

    const rows = await withClient(req.clientId, async (tx) => {
      if (cursor) {
        return (await tx`
          SELECT id, contact_id, session_id, status, ai_active, total_turns, created_at, updated_at
          FROM conversations
          WHERE created_at < ${cursor}
          ORDER BY created_at DESC LIMIT ${take}
        `) as unknown as ConvRow[]
      }
      return (await tx`
        SELECT id, contact_id, session_id, status, ai_active, total_turns, created_at, updated_at
        FROM conversations
        ORDER BY created_at DESC LIMIT ${take}
      `) as unknown as ConvRow[]
    })

    const nextCursor = rows.length === take ? rows[rows.length - 1]?.created_at : null

    return {
      data: rows.map((r) => ({
        id:          r.id,
        contactId:   r.contact_id,
        sessionId:   r.session_id,
        status:      r.status,
        aiActive:    r.ai_active,
        totalTurns:  r.total_turns,
        createdAt:   r.created_at,
        updatedAt:   r.updated_at,
      })),
      nextCursor,
    }
  })

  // ── GET /v1/conversations/:id/messages ──────────────────────

  app.get('/conversations/:id/messages', async (req, _reply) => {
    assertScope(req, 'messaging')
    const { id: convId } = req.params as { id: string }
    const { limit = '50', cursor } = req.query as Record<string, string | undefined>
    const take = Math.min(parseInt(limit, 10) || 50, 200)

    type MsgRow = {
      id: string
      direction: string
      content: string
      content_type: string
      status: string
      wa_message_id: string | null
      ai_generated: boolean
      created_at: string
    }

    const rows = await withClient(req.clientId, async (tx) => {
      // Ownership check — RLS ensures this only returns data for req.clientId
      const convs = (await tx`
        SELECT id FROM conversations WHERE id = ${convId}
      `) as unknown as Array<{ id: string }>
      if (!convs[0]) throw new NotFoundError('Conversation')

      if (cursor) {
        return (await tx`
          SELECT id, direction, content, content_type, status,
                 wa_message_id, ai_generated, created_at
          FROM messages
          WHERE conversation_id = ${convId} AND created_at > ${cursor}
          ORDER BY created_at ASC LIMIT ${take}
        `) as unknown as MsgRow[]
      }
      return (await tx`
        SELECT id, direction, content, content_type, status,
               wa_message_id, ai_generated, created_at
        FROM messages
        WHERE conversation_id = ${convId}
        ORDER BY created_at ASC LIMIT ${take}
      `) as unknown as MsgRow[]
    })

    const nextCursor = rows.length === take ? rows[rows.length - 1]?.created_at : null

    return {
      data: rows.map((r) => ({
        id:          r.id,
        direction:   r.direction,
        content:     r.content,
        contentType: r.content_type,
        status:      r.status,
        waMessageId: r.wa_message_id,
        aiGenerated: r.ai_generated,
        createdAt:   r.created_at,
      })),
      nextCursor,
    }
  })
}

export default messagesRoutes
