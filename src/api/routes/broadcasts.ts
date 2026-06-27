// ── BROADCAST ROUTES ──────────────────────────────────────────
//
// WhatsApp broadcast campaigns — send one message to many contacts.
// All routes require operator secret auth.

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { Queue } from 'bullmq'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'
import { QUEUE } from '../../queues/definitions.js'
import type { BroadcastRecipientJob } from '../../queues/definitions.js'

const E164_RE = /^\+[1-9]\d{6,14}$/

function assertOperator(req: FastifyRequest, reply: FastifyReply): boolean {
  const raw    = req.headers['x-operator-secret']
  const secret = Array.isArray(raw) ? raw[0] : raw
  if (!secret || secret !== config.operatorSecret) {
    void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid operator secret' })
    return false
  }
  return true
}

async function auditLog(
  action: string,
  target: string,
  targetId: string | null,
  detail: string,
): Promise<void> {
  await adminDb`
    INSERT INTO audit_log (actor, actor_label, action, target, target_id, detail)
    VALUES ('operator', 'Operator', ${action}, ${target}, ${targetId}, ${detail})
  `
}

const broadcastRoutes: FastifyPluginAsync = async (app) => {
  const broadcastQueue = new Queue<BroadcastRecipientJob>(QUEUE.broadcast, {
    connection: { url: config.redis.url },
  })

  // ── GET /broadcasts — list all broadcasts ─────────────────────

  app.get('/', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.query as { clientId?: string }

    type Row = {
      id: string; name: string; status: string; content: string
      total_recipients: number; total_sent: number; total_failed: number
      started_at: string | null; completed_at: string | null; created_at: string
      client_name: string; session_phone: string
    }

    const rows = clientId
      ? (await adminDb`
          SELECT b.*, c.name AS client_name, s.phone_number AS session_phone
          FROM   whatsapp_broadcasts b
          JOIN   clients c ON c.id = b.client_id
          JOIN   whatsapp_sessions s ON s.id = b.session_id
          WHERE  b.client_id = ${clientId}
          ORDER BY b.created_at DESC LIMIT 100
        `) as unknown as Row[]
      : (await adminDb`
          SELECT b.*, c.name AS client_name, s.phone_number AS session_phone
          FROM   whatsapp_broadcasts b
          JOIN   clients c ON c.id = b.client_id
          JOIN   whatsapp_sessions s ON s.id = b.session_id
          ORDER BY b.created_at DESC LIMIT 200
        `) as unknown as Row[]

    return reply.send(rows.map(r => ({
      id:               r.id,
      name:             r.name,
      status:           r.status,
      content:          r.content,
      totalRecipients:  Number(r.total_recipients),
      totalSent:        Number(r.total_sent),
      totalFailed:      Number(r.total_failed),
      startedAt:        r.started_at,
      completedAt:      r.completed_at,
      createdAt:        r.created_at,
      clientName:       r.client_name,
      sessionPhone:     r.session_phone,
    })))
  })

  // ── POST /broadcasts — create a new broadcast ─────────────────

  app.post('/', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      clientId?: string; sessionId?: string; name?: string
      content?: string; contentType?: string
      recipients?: { phoneNumber: string; name?: string }[]
    }

    if (!body.clientId || !body.sessionId || !body.name?.trim() || !body.content?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'clientId, sessionId, name, and content are required' })
    }

    type BRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO whatsapp_broadcasts (client_id, session_id, name, content, content_type, total_recipients)
      VALUES (
        ${body.clientId}, ${body.sessionId}, ${body.name.trim()},
        ${body.content.trim()}, ${body.contentType ?? 'text'},
        ${body.recipients?.length ?? 0}
      )
      RETURNING id, created_at
    `) as unknown as BRow[]

    const broadcastId = rows[0]!.id

    // Insert recipients if provided
    if (body.recipients && body.recipients.length > 0) {
      const valid = body.recipients.filter(r => E164_RE.test(r.phoneNumber))
      for (const r of valid) {
        await adminDb`
          INSERT INTO broadcast_recipients (broadcast_id, client_id, phone_number, name)
          VALUES (${broadcastId}, ${body.clientId}, ${r.phoneNumber}, ${r.name ?? null})
          ON CONFLICT DO NOTHING
        `
      }
      // Update count to reflect only valid numbers
      await adminDb`
        UPDATE whatsapp_broadcasts SET total_recipients = ${valid.length} WHERE id = ${broadcastId}
      `
    }

    await auditLog(
      'broadcast.created',
      body.name.trim(),
      broadcastId,
      `Created broadcast "${body.name.trim()}" with ${body.recipients?.length ?? 0} recipient(s)`,
    )

    return reply.status(201).send({ id: broadcastId, createdAt: rows[0]!.created_at })
  })

  // ── GET /broadcasts/:id — get broadcast with recipients ───────

  app.get('/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type BRow2 = {
      id: string; name: string; status: string; content: string; content_type: string
      total_recipients: number; total_sent: number; total_failed: number
      started_at: string | null; completed_at: string | null; created_at: string
      client_name: string; session_phone: string
    }
    const rows = (await adminDb`
      SELECT b.*, c.name AS client_name, s.phone_number AS session_phone
      FROM   whatsapp_broadcasts b
      JOIN   clients c ON c.id = b.client_id
      JOIN   whatsapp_sessions s ON s.id = b.session_id
      WHERE  b.id = ${id}
    `) as unknown as BRow2[]

    if (!rows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Broadcast not found' })

    type RRow = { id: string; phone_number: string; name: string | null; status: string; error: string | null; sent_at: string | null }
    const recipients = (await adminDb`
      SELECT id, phone_number, name, status, error, sent_at
      FROM   broadcast_recipients
      WHERE  broadcast_id = ${id}
      ORDER BY created_at ASC LIMIT 500
    `) as unknown as RRow[]

    const r = rows[0]!
    return reply.send({
      id: r.id, name: r.name, status: r.status,
      content: r.content, contentType: r.content_type,
      totalRecipients: Number(r.total_recipients),
      totalSent: Number(r.total_sent), totalFailed: Number(r.total_failed),
      startedAt: r.started_at, completedAt: r.completed_at, createdAt: r.created_at,
      clientName: r.client_name, sessionPhone: r.session_phone,
      recipients: recipients.map(rec => ({
        id: rec.id, phoneNumber: rec.phone_number, name: rec.name,
        status: rec.status, error: rec.error, sentAt: rec.sent_at,
      })),
    })
  })

  // ── PATCH /broadcasts/:id — edit a draft broadcast ────────────

  app.patch('/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type BCRow = { client_id: string; status: string; name: string }
    const bc = (await adminDb`SELECT client_id, status, name FROM whatsapp_broadcasts WHERE id = ${id}`) as unknown as BCRow[]
    if (!bc[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Broadcast not found' })
    if (bc[0].status !== 'draft') return reply.status(409).send({ error: 'CONFLICT', message: 'Only draft broadcasts can be edited' })

    const body = req.body as {
      name?: string
      content?: string
      recipients?: { phoneNumber: string; name?: string }[]
    }

    const updates: string[] = []
    if (body.name?.trim()) updates.push('name')
    if (body.content?.trim()) updates.push('content')

    if (body.name?.trim()) {
      await adminDb`UPDATE whatsapp_broadcasts SET name = ${body.name.trim()}, updated_at = NOW() WHERE id = ${id}`
    }
    if (body.content?.trim()) {
      await adminDb`UPDATE whatsapp_broadcasts SET content = ${body.content.trim()}, updated_at = NOW() WHERE id = ${id}`
    }

    if (body.recipients !== undefined) {
      // Replace all recipients
      await adminDb`DELETE FROM broadcast_recipients WHERE broadcast_id = ${id}`
      const valid = body.recipients.filter(r => E164_RE.test(r.phoneNumber))
      for (const r of valid) {
        await adminDb`
          INSERT INTO broadcast_recipients (broadcast_id, client_id, phone_number, name)
          VALUES (${id}, ${bc[0].client_id}, ${r.phoneNumber}, ${r.name ?? null})
          ON CONFLICT DO NOTHING
        `
      }
      await adminDb`UPDATE whatsapp_broadcasts SET total_recipients = ${valid.length}, updated_at = NOW() WHERE id = ${id}`
      updates.push(`recipients(${valid.length})`)
    }

    const finalName = body.name?.trim() ?? bc[0].name
    await auditLog(
      'broadcast.updated',
      finalName,
      id,
      `Updated ${updates.join(', ') || 'nothing'} on broadcast "${finalName}"`,
    )

    type UpdatedRow = { id: string; name: string; content: string; total_recipients: number; updated_at: string }
    const updated = (await adminDb`
      SELECT id, name, content, total_recipients, updated_at FROM whatsapp_broadcasts WHERE id = ${id}
    `) as unknown as UpdatedRow[]

    return reply.send(updated[0])
  })

  // ── POST /broadcasts/:id/recipients — add recipients ──────────

  app.post('/:id/recipients', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type BCRow = { client_id: string; status: string }
    const bc = (await adminDb`SELECT client_id, status FROM whatsapp_broadcasts WHERE id = ${id}`) as unknown as BCRow[]
    if (!bc[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Broadcast not found' })
    if (bc[0].status !== 'draft') return reply.status(409).send({ error: 'CONFLICT', message: 'Can only add recipients to a draft broadcast' })

    const body = req.body as { recipients?: { phoneNumber: string; name?: string }[] }
    if (!body.recipients?.length) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'recipients array is required' })
    }

    let added = 0
    for (const r of body.recipients) {
      if (!E164_RE.test(r.phoneNumber)) continue
      await adminDb`
        INSERT INTO broadcast_recipients (broadcast_id, client_id, phone_number, name)
        VALUES (${id}, ${bc[0].client_id}, ${r.phoneNumber}, ${r.name ?? null})
        ON CONFLICT DO NOTHING
      `
      added++
    }

    type CountRow = { total: string }
    const cnt = (await adminDb`SELECT COUNT(*)::text AS total FROM broadcast_recipients WHERE broadcast_id = ${id}`) as unknown as CountRow[]
    await adminDb`UPDATE whatsapp_broadcasts SET total_recipients = ${parseInt(cnt[0]?.total ?? '0', 10)} WHERE id = ${id}`

    return reply.send({ added })
  })

  // ── POST /broadcasts/:id/send — start sending ─────────────────

  app.post('/:id/send', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type BCRow2 = { client_id: string; session_id: string; content: string; content_type: string; status: string; name: string }
    const bc = (await adminDb`
      SELECT client_id, session_id, content, content_type, status, name
      FROM   whatsapp_broadcasts WHERE id = ${id}
    `) as unknown as BCRow2[]

    if (!bc[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Broadcast not found' })
    if (bc[0].status === 'sending') return reply.status(409).send({ error: 'CONFLICT', message: 'Broadcast already sending' })
    if (bc[0].status === 'sent') return reply.status(409).send({ error: 'CONFLICT', message: 'Broadcast already sent — duplicate it to resend' })

    type RRow2 = { id: string; phone_number: string }
    const recipients = (await adminDb`
      SELECT id, phone_number FROM broadcast_recipients
      WHERE  broadcast_id = ${id} AND status = 'pending'
    `) as unknown as RRow2[]

    if (recipients.length === 0) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'No pending recipients — add recipients first' })
    }

    await adminDb`
      UPDATE whatsapp_broadcasts SET status = 'sending', started_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `

    // Queue one job per recipient — broadcast worker processes with concurrency 3
    for (const r of recipients) {
      await broadcastQueue.add('broadcast', {
        broadcastId:  id,
        recipientId:  r.id,
        clientId:     bc[0].client_id,
        sessionId:    bc[0].session_id,
        to:           r.phone_number,
        content:      bc[0].content,
        contentType:  bc[0].content_type as 'text',
      }, {
        attempts:        Number.MAX_SAFE_INTEGER,
        backoff:         { type: 'fixed', delay: 30_000 },
        removeOnComplete: true,
      })
    }

    await auditLog(
      'broadcast.sent',
      bc[0].name,
      id,
      `Queued ${recipients.length} recipient(s) for broadcast "${bc[0].name}"`,
    )

    return reply.send({ queued: recipients.length })
  })

  // ── POST /broadcasts/:id/duplicate — clone as a new draft ─────

  app.post('/:id/duplicate', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type SrcRow = { client_id: string; session_id: string; name: string; content: string; content_type: string }
    const src = (await adminDb`
      SELECT client_id, session_id, name, content, content_type
      FROM   whatsapp_broadcasts WHERE id = ${id}
    `) as unknown as SrcRow[]

    if (!src[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Broadcast not found' })

    const newName = `${src[0].name} (Copy)`

    type BRow = { id: string; created_at: string }
    const newRows = (await adminDb`
      INSERT INTO whatsapp_broadcasts (client_id, session_id, name, content, content_type, total_recipients)
      VALUES (${src[0].client_id}, ${src[0].session_id}, ${newName}, ${src[0].content}, ${src[0].content_type}, 0)
      RETURNING id, created_at
    `) as unknown as BRow[]

    const newId = newRows[0]!.id

    // Copy all recipients from the original (as fresh pending entries)
    type RRow = { phone_number: string; name: string | null }
    const srcRecipients = (await adminDb`
      SELECT phone_number, name FROM broadcast_recipients WHERE broadcast_id = ${id}
    `) as unknown as RRow[]

    for (const r of srcRecipients) {
      await adminDb`
        INSERT INTO broadcast_recipients (broadcast_id, client_id, phone_number, name)
        VALUES (${newId}, ${src[0].client_id}, ${r.phone_number}, ${r.name})
        ON CONFLICT DO NOTHING
      `
    }

    if (srcRecipients.length > 0) {
      await adminDb`
        UPDATE whatsapp_broadcasts SET total_recipients = ${srcRecipients.length} WHERE id = ${newId}
      `
    }

    await auditLog(
      'broadcast.duplicated',
      newName,
      newId,
      `Duplicated broadcast "${src[0].name}" → "${newName}" with ${srcRecipients.length} recipient(s)`,
    )

    return reply.status(201).send({ id: newId, createdAt: newRows[0]!.created_at })
  })

  // ── POST /broadcasts/:id/cancel — cancel a sending broadcast ──

  app.post('/:id/cancel', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type NameRow = { name: string }
    const nameRows = (await adminDb`SELECT name FROM whatsapp_broadcasts WHERE id = ${id}`) as unknown as NameRow[]

    await adminDb`
      UPDATE whatsapp_broadcasts SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${id} AND status IN ('draft', 'sending')
    `
    // Mark pending recipients as failed
    await adminDb`
      UPDATE broadcast_recipients SET status = 'failed', error = 'Broadcast cancelled'
      WHERE broadcast_id = ${id} AND status = 'pending'
    `

    if (nameRows[0]) {
      await auditLog('broadcast.cancelled', nameRows[0].name, id, `Cancelled broadcast "${nameRows[0].name}"`)
    }

    return reply.send({ cancelled: true })
  })

  // ── DELETE /broadcasts/:id — delete a draft broadcast ─────────

  app.delete('/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type NameRow = { name: string }
    const nameRows = (await adminDb`SELECT name FROM whatsapp_broadcasts WHERE id = ${id}`) as unknown as NameRow[]

    await adminDb`
      DELETE FROM whatsapp_broadcasts WHERE id = ${id} AND status IN ('draft', 'cancelled')
    `

    if (nameRows[0]) {
      await auditLog('broadcast.deleted', nameRows[0].name, id, `Deleted broadcast "${nameRows[0].name}"`)
    }

    return reply.status(204).send()
  })
}

export default broadcastRoutes
