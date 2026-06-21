// ── REQUESTS + AI TEMPLATES ROUTES ────────────────────────────
//
// Onboarding request queue (public signups awaiting operator review)
// and the AI scenario template library.
//
// All routes require X-Operator-Secret.
//
// Routes:
//   GET  /v1/admin/requests
//   POST /v1/admin/requests/:id/approve
//   POST /v1/admin/requests/:id/reject
//   GET  /v1/admin/ai-templates
//   POST /v1/admin/ai-templates
//   PATCH /v1/admin/ai-templates/:id
//   DELETE /v1/admin/ai-templates/:id  (soft-archive)

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'
import { NotFoundError } from '../../shared/errors.js'

// ── Auth guard ────────────────────────────────────────────────

function assertOperator(req: FastifyRequest, reply: FastifyReply): boolean {
  const raw    = req.headers['x-operator-secret']
  const secret = Array.isArray(raw) ? raw[0] : raw
  if (!secret || secret !== config.operatorSecret) {
    void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid operator secret' })
    return false
  }
  return true
}

// ── Row types ─────────────────────────────────────────────────

type RequestRow = {
  id: string
  tier: string
  business_name: string
  contact_email: string
  contact_phone: string | null
  description: string | null
  plan_id: string | null
  plan_name: string | null
  status: string
  rejected_reason: string | null
  approved_at: Date | null
  rejected_at: Date | null
  created_at: string
}

type TemplateRow = {
  id: string
  name: string
  category: string
  description: string
  instruction: string
  trigger_keywords: string[]
  fields: unknown
  archived: boolean
  created_at: string
  updated_at: string
}

// ── Plugin ────────────────────────────────────────────────────

const requestsRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /v1/admin/requests ──────────────────────────────────
  // List all onboarding requests, newest first.

  app.get('/requests', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const rows = (await adminDb`
      SELECT
        r.id, r.tier, r.business_name, r.contact_email, r.contact_phone,
        r.description, r.plan_id, p.name AS plan_name,
        r.status, r.rejected_reason, r.approved_at, r.rejected_at,
        r.created_at
      FROM  onboarding_requests r
      LEFT JOIN plans p ON p.id = r.plan_id
      ORDER BY r.created_at DESC
    `) as unknown as RequestRow[]

    return rows.map(r => ({
      id:             r.id,
      tier:           r.tier,
      businessName:   r.business_name,
      contactEmail:   r.contact_email,
      contactPhone:   r.contact_phone,
      description:    r.description,
      planId:         r.plan_id,
      planName:       r.plan_name,
      status:         r.status,
      rejectedReason: r.rejected_reason,
      createdAt:      r.created_at,
    }))
  })

  // ── POST /v1/admin/requests/:id/approve ────────────────────
  // Approve request and automatically provision a client account.

  app.post('/requests/:id/approve', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }

    const rows = (await adminDb`
      SELECT * FROM onboarding_requests WHERE id = ${id}
    `) as unknown as RequestRow[]

    const request = rows[0]
    if (!request) throw new NotFoundError('Onboarding request')

    if (request.status !== 'pending') {
      return reply.status(409).send({
        error: 'CONFLICT',
        message: `Request has already been ${request.status}`,
      })
    }

    // Resolve plan — use provided plan or fall back to starter
    let planId = request.plan_id
    if (!planId) {
      const starterRows = (await adminDb`
        SELECT id FROM plans WHERE name = 'starter' LIMIT 1
      `) as unknown as Array<{ id: string }>
      planId = starterRows[0]?.id ?? null
    }

    if (!planId) {
      return reply.status(500).send({
        error: 'INTERNAL_ERROR',
        message: 'No default plan found. Create a starter plan before approving requests.',
      })
    }

    // Provision the client
    type ClientRow = { id: string }
    const clientRows = (await adminDb`
      INSERT INTO clients (name, type, plan_id, contact_email, status)
      VALUES (
        ${request.business_name},
        'external',
        ${planId},
        ${request.contact_email},
        'active'
      )
      RETURNING id
    `) as unknown as ClientRow[]

    const clientId = clientRows[0]!.id

    // Mark request approved
    await adminDb`
      UPDATE onboarding_requests
      SET status = 'approved', approved_at = NOW()
      WHERE id = ${id}
    `

    // Audit log
    await adminDb`
      INSERT INTO audit_log (actor, actor_label, action, target, target_id, detail)
      VALUES (
        'operator', 'ERA Systems', 'approved_request',
        'onboarding_request', ${id},
        ${'Approved and created client account ' + clientId + ' for ' + request.business_name}
      )
    `

    return reply.status(201).send({ clientId })
  })

  // ── POST /v1/admin/requests/:id/reject ─────────────────────

  app.post('/requests/:id/reject', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const body   = req.body as { reason?: string }

    const rows = (await adminDb`
      SELECT id, status, business_name FROM onboarding_requests WHERE id = ${id}
    `) as unknown as Array<{ id: string; status: string; business_name: string }>

    const request = rows[0]
    if (!request) throw new NotFoundError('Onboarding request')

    if (request.status !== 'pending') {
      return reply.status(409).send({
        error: 'CONFLICT',
        message: `Request has already been ${request.status}`,
      })
    }

    await adminDb`
      UPDATE onboarding_requests
      SET status = 'rejected', rejected_at = NOW(), rejected_reason = ${body.reason ?? null}
      WHERE id = ${id}
    `

    await adminDb`
      INSERT INTO audit_log (actor, actor_label, action, target, target_id, detail)
      VALUES (
        'operator', 'ERA Systems', 'rejected_request',
        'onboarding_request', ${id},
        ${'Rejected request for ' + request.business_name + (body.reason ? ': ' + body.reason : '')}
      )
    `

    return reply.status(204).send()
  })

  // ── GET /v1/admin/ai-templates ─────────────────────────────

  app.get('/ai-templates', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const rows = (await adminDb`
      SELECT id, name, category, description, instruction,
             trigger_keywords, fields, archived, created_at, updated_at
      FROM   ai_templates
      WHERE  archived = FALSE
      ORDER  BY category ASC, name ASC
    `) as unknown as TemplateRow[]

    return rows.map(t => ({
      id:              t.id,
      name:            t.name,
      category:        t.category,
      description:     t.description,
      instruction:     t.instruction,
      triggerKeywords: t.trigger_keywords,
      fields:          t.fields,
      archived:        t.archived,
      createdAt:       t.created_at,
    }))
  })

  // ── POST /v1/admin/ai-templates ────────────────────────────

  app.post('/ai-templates', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      name?: string
      category?: string
      description?: string
      instruction?: string
      triggerKeywords?: string[]
      fields?: unknown[]
    }

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name is required' })
    }
    if (!body.category?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'category is required' })
    }

    const rows = (await adminDb`
      INSERT INTO ai_templates (name, category, description, instruction, trigger_keywords, fields)
      VALUES (
        ${body.name.trim()},
        ${body.category.trim()},
        ${body.description ?? ''},
        ${body.instruction ?? ''},
        ${body.triggerKeywords ?? []},
        ${JSON.stringify(body.fields ?? [])}
      )
      RETURNING id, name, category, description, instruction, trigger_keywords, fields, archived, created_at
    `) as unknown as TemplateRow[]

    const t = rows[0]!
    return reply.status(201).send({
      id:              t.id,
      name:            t.name,
      category:        t.category,
      description:     t.description,
      instruction:     t.instruction,
      triggerKeywords: t.trigger_keywords,
      fields:          t.fields,
      archived:        t.archived,
      createdAt:       t.created_at,
    })
  })

  // ── PATCH /v1/admin/ai-templates/:id ───────────────────────

  app.patch('/ai-templates/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const body   = req.body as {
      name?:            string
      category?:        string
      description?:     string
      instruction?:     string
      triggerKeywords?: string[]
      fields?:          unknown[]
      archived?:        boolean
    }

    const existing = (await adminDb`
      SELECT id FROM ai_templates WHERE id = ${id}
    `) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('AI template')

    // Build update dynamically — only set provided fields
    // postgres.js doesn't support fully dynamic SET lists natively,
    // so we update all columns but preserve existing values via COALESCE where body field is absent.
    const rows = (await adminDb`
      UPDATE ai_templates SET
        name             = ${body.name             ?? adminDb`name`},
        category         = ${body.category         ?? adminDb`category`},
        description      = ${body.description      ?? adminDb`description`},
        instruction      = ${body.instruction      ?? adminDb`instruction`},
        trigger_keywords = ${body.triggerKeywords  ?? adminDb`trigger_keywords`},
        fields           = ${body.fields !== undefined ? JSON.stringify(body.fields) : adminDb`fields`},
        archived         = ${body.archived         ?? adminDb`archived`},
        updated_at       = NOW()
      WHERE id = ${id}
      RETURNING id, name, category, description, instruction, trigger_keywords, fields, archived, created_at
    `) as unknown as TemplateRow[]

    const t = rows[0]!
    return {
      id:              t.id,
      name:            t.name,
      category:        t.category,
      description:     t.description,
      instruction:     t.instruction,
      triggerKeywords: t.trigger_keywords,
      fields:          t.fields,
      archived:        t.archived,
      createdAt:       t.created_at,
    }
  })

  // ── DELETE /v1/admin/ai-templates/:id ──────────────────────
  // Soft-archive — never hard-delete templates (businesses may reference them).

  app.delete('/ai-templates/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }

    const rows = (await adminDb`
      UPDATE ai_templates SET archived = TRUE, updated_at = NOW()
      WHERE id = ${id} AND archived = FALSE
      RETURNING id
    `) as unknown as Array<{ id: string }>

    if (!rows[0]) throw new NotFoundError('AI template')

    return reply.status(204).send()
  })
}

export default requestsRoutes
