import type { FastifyPluginAsync } from 'fastify'
import { adminDb } from '../../db/client.js'

const publicRoutes: FastifyPluginAsync = async (app) => {

  // POST /v1/public/requests — AI agent or developer signup
  app.post('/requests', async (req, reply) => {
    const body = req.body as {
      tier?: string; businessName?: string; contactEmail?: string
      contactPhone?: string; description?: string; planId?: string
    }

    if (!body.tier || !['ai_agent', 'developer'].includes(body.tier)) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'tier must be ai_agent or developer' })
    }
    if (!body.businessName?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'businessName is required' })
    }
    if (!body.contactEmail?.trim() || !body.contactEmail.includes('@')) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Valid contactEmail is required' })
    }

    type InsertRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO onboarding_requests
        (tier, business_name, contact_email, contact_phone, description, plan_id)
      VALUES (
        ${body.tier}, ${body.businessName.trim()},
        ${body.contactEmail.trim().toLowerCase()},
        ${body.contactPhone ?? null}, ${body.description ?? null},
        ${body.planId ?? null}
      )
      RETURNING id, created_at
    `) as unknown as InsertRow[]

    const row = rows[0]!

    // Log the submission event
    await adminDb`
      INSERT INTO platform_events (event_type, severity, detail)
      VALUES ('request_submitted', 'info', ${'New signup request: ' + body.businessName.trim()})
    `

    return reply.status(201).send({
      id: row.id,
      message: 'Application submitted. Our team will be in touch shortly.',
      createdAt: row.created_at,
    })
  })
}

export default publicRoutes
