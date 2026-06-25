import type { FastifyPluginAsync } from 'fastify'
import { adminDb } from '../../db/client.js'

const publicRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /v1/public/reveal/:token ────────────────────────────
  // One-time API key reveal. No auth — the token IS the auth.

  app.get('/reveal/:token', async (req, reply) => {
    const { token } = req.params as { token: string }

    const rows = (await adminDb`
      SELECT key_value, label, client_name, expires_at, used_at
      FROM api_key_reveal_tokens WHERE token = ${token}
    `) as unknown as Array<{
      key_value: string; label: string; client_name: string
      expires_at: string; used_at: string | null
    }>

    const row = rows[0]
    if (!row)        return reply.status(404).send({ error: 'INVALID_TOKEN',  message: 'This link is invalid or has already expired.' })
    if (row.used_at) return reply.status(410).send({ error: 'ALREADY_USED',   message: 'This link has already been used. Contact ERA Systems for a new link.' })
    if (new Date() > new Date(row.expires_at)) return reply.status(410).send({ error: 'EXPIRED', message: 'This link has expired. Contact ERA Systems for a new link.' })

    // Mark used immediately — one time only
    await adminDb`UPDATE api_key_reveal_tokens SET used_at = NOW() WHERE token = ${token}`

    return reply.send({ key: row.key_value, label: row.label, clientName: row.client_name })
  })

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
