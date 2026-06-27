// ── AUTOMATION ROUTES ─────────────────────────────────────────
//
// Drip sequence / automation flow management.
// Operator routes: require X-Operator-Secret
// Public trigger route: require trigger_key in URL param

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'
import { randomBytes } from 'node:crypto'
import { auditLog } from '../../services/audit.js'
import { logEvent } from '../../services/events.js'

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

const automationRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /automations — list all flows ─────────────────────────

  app.get('/', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.query as { clientId?: string }

    type Row = {
      id: string; name: string; description: string | null
      trigger_type: string; trigger_key: string | null; status: string
      total_enrolled: number; total_completed: number; created_at: string
      client_name: string; session_phone: string
    }

    const rows = clientId
      ? (await adminDb`
          SELECT f.*, c.name AS client_name, s.phone_number AS session_phone
          FROM   automation_flows f
          JOIN   clients c ON c.id = f.client_id
          JOIN   whatsapp_sessions s ON s.id = f.session_id
          WHERE  f.client_id = ${clientId} AND f.status != 'archived'
          ORDER BY f.created_at DESC
        `) as unknown as Row[]
      : (await adminDb`
          SELECT f.*, c.name AS client_name, s.phone_number AS session_phone
          FROM   automation_flows f
          JOIN   clients c ON c.id = f.client_id
          JOIN   whatsapp_sessions s ON s.id = f.session_id
          WHERE  f.status != 'archived'
          ORDER BY f.created_at DESC LIMIT 200
        `) as unknown as Row[]

    return reply.send(rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      triggerType: r.trigger_type, triggerKey: r.trigger_key, status: r.status,
      totalEnrolled: Number(r.total_enrolled), totalCompleted: Number(r.total_completed),
      createdAt: r.created_at, clientName: r.client_name, sessionPhone: r.session_phone,
    })))
  })

  // ── POST /automations — create a flow with steps ──────────────

  app.post('/', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      clientId?: string; sessionId?: string; name?: string; description?: string
      triggerType?: 'api' | 'manual'
      steps?: { stepType: 'send_message' | 'wait'; content?: string; contentType?: string; delayMinutes?: number }[]
    }

    if (!body.clientId || !body.sessionId || !body.name?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'clientId, sessionId, name are required' })
    }

    const triggerType = body.triggerType ?? 'manual'
    const triggerKey  = triggerType === 'api' ? randomBytes(12).toString('hex') : null

    type FRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO automation_flows (client_id, session_id, name, description, trigger_type, trigger_key)
      VALUES (${body.clientId}, ${body.sessionId}, ${body.name.trim()}, ${body.description ?? null}, ${triggerType}, ${triggerKey})
      RETURNING id, created_at
    `) as unknown as FRow[]

    const flowId = rows[0]!.id

    // Insert steps
    const steps = body.steps ?? []
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      await adminDb`
        INSERT INTO automation_steps (flow_id, step_order, step_type, content, content_type, delay_minutes)
        VALUES (${flowId}, ${i}, ${s.stepType}, ${s.content ?? null}, ${s.contentType ?? 'text'}, ${s.delayMinutes ?? 0})
      `
    }

    auditLog({ actor: 'operator', actorLabel: 'Operator', action: 'automation.created', target: 'automation_flow', targetId: flowId, detail: `Created automation flow "${body.name.trim()}" for client ${body.clientId}` }).catch(() => {})
    return reply.status(201).send({ id: flowId, triggerKey, createdAt: rows[0]!.created_at })
  })

  // ── GET /automations/:id — get flow with steps ────────────────

  app.get('/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type FRow2 = {
      id: string; name: string; description: string | null
      trigger_type: string; trigger_key: string | null; status: string
      total_enrolled: number; total_completed: number; created_at: string
      client_name: string; session_phone: string
    }
    const flows = (await adminDb`
      SELECT f.*, c.name AS client_name, s.phone_number AS session_phone
      FROM   automation_flows f
      JOIN   clients c ON c.id = f.client_id
      JOIN   whatsapp_sessions s ON s.id = f.session_id
      WHERE  f.id = ${id}
    `) as unknown as FRow2[]

    if (!flows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Flow not found' })

    type SRow = { id: string; step_order: number; step_type: string; content: string | null; content_type: string; delay_minutes: number }
    const steps = (await adminDb`
      SELECT id, step_order, step_type, content, content_type, delay_minutes
      FROM   automation_steps WHERE flow_id = ${id} ORDER BY step_order
    `) as unknown as SRow[]

    type ERow = { total: string; completed: string; active: string }
    const counts = (await adminDb`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
        COUNT(*) FILTER (WHERE status = 'active')::text AS active
      FROM automation_enrollments WHERE flow_id = ${id}
    `) as unknown as ERow[]

    const f = flows[0]!
    return reply.send({
      id: f.id, name: f.name, description: f.description,
      triggerType: f.trigger_type, triggerKey: f.trigger_key, status: f.status,
      totalEnrolled: Number(f.total_enrolled), totalCompleted: Number(f.total_completed),
      createdAt: f.created_at, clientName: f.client_name, sessionPhone: f.session_phone,
      enrollmentStats: {
        total:     parseInt(counts[0]?.total ?? '0', 10),
        active:    parseInt(counts[0]?.active ?? '0', 10),
        completed: parseInt(counts[0]?.completed ?? '0', 10),
      },
      steps: steps.map(s => ({
        id: s.id, stepOrder: s.step_order, stepType: s.step_type,
        content: s.content, contentType: s.content_type, delayMinutes: s.delay_minutes,
      })),
    })
  })

  // ── PATCH /automations/:id — update flow status ───────────────

  app.patch('/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    const body = req.body as { status?: 'active' | 'paused' | 'archived'; name?: string; description?: string }

    await adminDb`
      UPDATE automation_flows SET
        name        = COALESCE(${body.name ?? null}, name),
        description = COALESCE(${body.description ?? null}, description),
        status      = COALESCE(${body.status ?? null}, status),
        updated_at  = NOW()
      WHERE id = ${id}
    `
    const action = body.status === 'paused' ? 'automation.paused' : body.status === 'active' ? 'automation.resumed' : 'automation.updated'
    const detail = body.status ? `Flow status changed to ${body.status}` : `Flow updated${body.name ? ` — renamed to "${body.name}"` : ''}`
    auditLog({ actor: 'operator', actorLabel: 'Operator', action, target: 'automation_flow', targetId: id, detail }).catch(() => {})
    return reply.status(204).send()
  })

  // ── DELETE /automations/:id — archive a flow ──────────────────

  app.delete('/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`UPDATE automation_flows SET status = 'archived', updated_at = NOW() WHERE id = ${id}`
    auditLog({ actor: 'operator', actorLabel: 'Operator', action: 'automation.archived', target: 'automation_flow', targetId: id, detail: 'Automation flow archived' }).catch(() => {})
    return reply.status(204).send()
  })

  // ── POST /automations/:id/enroll — enroll contacts ───────────

  app.post('/:id/enroll', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type FRow3 = { client_id: string; status: string }
    const flows = (await adminDb`SELECT client_id, status FROM automation_flows WHERE id = ${id}`) as unknown as FRow3[]
    if (!flows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Flow not found' })
    if (flows[0].status !== 'active') return reply.status(409).send({ error: 'CONFLICT', message: 'Flow is not active' })

    const body = req.body as { contacts?: { phoneNumber: string; name?: string }[] }
    if (!body.contacts?.length) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'contacts array is required' })
    }

    let enrolled = 0
    const clientId = flows[0].client_id

    for (const c of body.contacts) {
      if (!E164_RE.test(c.phoneNumber)) continue
      try {
        await adminDb`
          INSERT INTO automation_enrollments (flow_id, client_id, phone_number, name, next_step_at)
          VALUES (${id}, ${clientId}, ${c.phoneNumber}, ${c.name ?? null}, NOW())
          ON CONFLICT (flow_id, phone_number) DO NOTHING
        `
        enrolled++
      } catch { /* skip duplicates */ }
    }

    await adminDb`
      UPDATE automation_flows SET total_enrolled = total_enrolled + ${enrolled}, updated_at = NOW() WHERE id = ${id}
    `

    if (enrolled > 0) {
      auditLog({ actor: 'operator', actorLabel: 'Operator', action: 'automation.contact_enrolled', target: 'automation_flow', targetId: id, detail: `${enrolled} contact(s) enrolled in automation flow` }).catch(() => {})
      logEvent({ eventType: 'automation_triggered', severity: 'info', detail: `${enrolled} contact(s) enrolled in automation flow`, clientId }).catch(() => {})
    }

    return reply.send({ enrolled })
  })

  // ── GET /automations/:id/enrollments — list enrollments ───────

  app.get('/:id/enrollments', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }

    type ERow2 = { id: string; phone_number: string; name: string | null; current_step: number; status: string; next_step_at: string; created_at: string }
    const rows = (await adminDb`
      SELECT id, phone_number, name, current_step, status, next_step_at, created_at
      FROM   automation_enrollments WHERE flow_id = ${id}
      ORDER BY created_at DESC LIMIT 200
    `) as unknown as ERow2[]

    return reply.send(rows.map(r => ({
      id: r.id, phoneNumber: r.phone_number, name: r.name,
      currentStep: r.current_step, status: r.status,
      nextStepAt: r.next_step_at, createdAt: r.created_at,
    })))
  })

  // ── PUBLIC: POST /public/automations/trigger/:key ─────────────
  // External apps call this to enroll a contact in an automation flow.
  // Authenticated by the trigger_key embedded in the URL.

  app.post('/public/trigger/:key', async (req, reply) => {
    const { key } = req.params as { key: string }
    const body = req.body as { phoneNumber?: string; name?: string }

    if (!body.phoneNumber || !E164_RE.test(body.phoneNumber)) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'phoneNumber must be a valid E.164 number (e.g. +2348012345678)' })
    }

    type FRow4 = { id: string; client_id: string; status: string }
    const flows = (await adminDb`
      SELECT id, client_id, status FROM automation_flows WHERE trigger_key = ${key}
    `) as unknown as FRow4[]

    if (!flows[0] || flows[0].status !== 'active') {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Automation not found or not active' })
    }

    const flow = flows[0]!

    await adminDb`
      INSERT INTO automation_enrollments (flow_id, client_id, phone_number, name, next_step_at)
      VALUES (${flow.id}, ${flow.client_id}, ${body.phoneNumber}, ${body.name ?? null}, NOW())
      ON CONFLICT (flow_id, phone_number) DO NOTHING
    `

    await adminDb`
      UPDATE automation_flows SET total_enrolled = total_enrolled + 1, updated_at = NOW() WHERE id = ${flow.id}
    `

    return reply.status(202).send({ enrolled: true, flowId: flow.id })
  })
}

export default automationRoutes
