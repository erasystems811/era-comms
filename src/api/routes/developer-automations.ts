import type { FastifyPluginAsync } from 'fastify'
import { adminDb } from '../../db/client.js'
import { assertScope } from '../middleware/auth.js'

const E164 = /^\+[1-9]\d{6,14}$/

const developerAutomationRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /v1/automations — list automations for authenticated client ──

  app.get('/', async (req, reply) => {
    assertScope(req, 'messaging')
    type FRow = { id: string; name: string; description: string | null; trigger_type: string; trigger_key: string | null; status: string; total_enrolled: number; total_completed: number; created_at: string; session_phone: string }
    const rows = (await adminDb`
      SELECT f.id, f.name, f.description, f.trigger_type, f.trigger_key, f.status,
             f.total_enrolled, f.total_completed, f.created_at, s.phone_number AS session_phone
      FROM automation_flows f
      JOIN whatsapp_sessions s ON s.id = f.session_id
      WHERE f.client_id = ${req.clientId} AND f.status != 'archived'
      ORDER BY f.created_at DESC
    `) as unknown as FRow[]
    return reply.send(rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      triggerType: r.trigger_type, triggerKey: r.trigger_key, status: r.status,
      totalEnrolled: Number(r.total_enrolled), totalCompleted: Number(r.total_completed),
      createdAt: r.created_at, sessionPhone: r.session_phone,
    })))
  })

  // ── POST /v1/automations/:id/enroll — enroll a contact via API key ──

  app.post('/:id/enroll', async (req, reply) => {
    assertScope(req, 'messaging')
    const { id } = req.params as { id: string }
    const body = req.body as { phoneNumber?: string; name?: string }

    if (!body.phoneNumber || !E164.test(body.phoneNumber)) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'phoneNumber must be E.164 (e.g. +2348012345678)' })
    }

    type FRow = { status: string }
    const flows = (await adminDb`
      SELECT status FROM automation_flows WHERE id = ${id} AND client_id = ${req.clientId}
    `) as unknown as FRow[]

    if (!flows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Automation not found' })
    if (flows[0].status !== 'active') return reply.status(409).send({ error: 'CONFLICT', message: 'Automation is not active' })

    await adminDb`
      INSERT INTO automation_enrollments (flow_id, client_id, phone_number, name, next_step_at)
      VALUES (${id}, ${req.clientId}, ${body.phoneNumber}, ${body.name ?? null}, NOW())
      ON CONFLICT (flow_id, phone_number) DO NOTHING
    `
    await adminDb`
      UPDATE automation_flows SET total_enrolled = total_enrolled + 1, updated_at = NOW() WHERE id = ${id}
    `
    return reply.status(202).send({ enrolled: true, flowId: id })
  })

  // ── DELETE /v1/automations/:id/enrollments/:phone — cancel by phone ──

  app.delete('/:id/enrollments/:phone', async (req, reply) => {
    assertScope(req, 'messaging')
    const { id, phone } = req.params as { id: string; phone: string }
    await adminDb`
      UPDATE automation_enrollments SET status = 'cancelled', updated_at = NOW()
      WHERE flow_id = ${id} AND client_id = ${req.clientId} AND phone_number = ${decodeURIComponent(phone)}
    `
    return reply.status(204).send()
  })

  // ── GET /v1/automations/:id/enrollments — list enrollments ──

  app.get('/:id/enrollments', async (req, reply) => {
    assertScope(req, 'messaging')
    const { id } = req.params as { id: string }
    const own = (await adminDb`SELECT id FROM automation_flows WHERE id = ${id} AND client_id = ${req.clientId}`) as unknown as Array<{ id: string }>
    if (!own[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Automation not found' })

    type ERow = { id: string; phone_number: string; name: string | null; current_step: number; status: string; next_step_at: string; created_at: string }
    const rows = (await adminDb`
      SELECT id, phone_number, name, current_step, status, next_step_at, created_at
      FROM automation_enrollments WHERE flow_id = ${id}
      ORDER BY created_at DESC LIMIT 500
    `) as unknown as ERow[]
    return reply.send(rows.map(r => ({
      id: r.id, phoneNumber: r.phone_number, name: r.name,
      currentStep: r.current_step, status: r.status,
      nextStepAt: r.next_step_at, createdAt: r.created_at,
    })))
  })
}

export default developerAutomationRoutes
