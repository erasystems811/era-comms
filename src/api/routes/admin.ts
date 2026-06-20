// ── OPERATOR ADMIN ROUTES ─────────────────────────────────────
//
// ERA Systems operator API — manages clients, plans, and API keys.
// Authentication: X-Operator-Secret header (not client API keys).
//
// Clients never access these routes. ERA Systems operators use them
// to onboard clients and provision API credentials.
//
// Routes:
//   GET  /v1/admin/plans                  — list available plans
//   POST /v1/admin/clients                — create a new client
//   GET  /v1/admin/clients                — list all clients
//   GET  /v1/admin/clients/:id            — client detail + live usage
//   PATCH /v1/admin/clients/:id           — update client (e.g. plan change)
//   POST /v1/admin/clients/:id/api-keys   — create API key for a client
//   DELETE /v1/admin/api-keys/:keyId      — revoke an API key

import { randomBytes, createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'
import { currentLimit } from '../../db/redis.js'
import { invalidatePlanCache } from '../../services/plan.js'
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

type PlanRow = {
  id: string; name: string; display_name: string
  ai_enabled: boolean; voice_enabled: boolean
  monthly_message_cap: number | null
  daily_message_cap: number | null
  hourly_message_cap: number | null
  max_sessions: number
}

type ClientRow = {
  id: string; name: string; type: string; status: string
  plan_id: string; plan_name: string
  contact_email: string | null
  created_at: string
}

type ApiKeyRow = {
  id: string; key_prefix: string; scopes: string[]
  environment: string; status: string
  expires_at: string | null; created_at: string
}

// ── Plugin ────────────────────────────────────────────────────

const adminRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /v1/admin/plans ─────────────────────────────────────

  app.get('/plans', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const rows = (await adminDb`
      SELECT id, name, display_name, ai_enabled, voice_enabled,
             monthly_message_cap, daily_message_cap, hourly_message_cap, max_sessions
      FROM   plans ORDER BY name
    `) as unknown as PlanRow[]

    return rows.map(p => ({
      id:               p.id,
      name:             p.name,
      displayName:      p.display_name,
      aiEnabled:        p.ai_enabled,
      voiceEnabled:     p.voice_enabled,
      limits: {
        monthlyMessages: p.monthly_message_cap,
        dailyMessages:   p.daily_message_cap,
        hourlyMessages:  p.hourly_message_cap,
        maxSessions:     p.max_sessions,
      },
    }))
  })

  // ── POST /v1/admin/clients ──────────────────────────────────

  app.post('/clients', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      name?: string
      type?: 'internal' | 'external'
      planId?: string
      categoryId?: string
      contactEmail?: string
    }

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name is required' })
    }
    if (!body.planId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'planId is required' })
    }

    const type: 'internal' | 'external' = body.type === 'internal' ? 'internal' : 'external'

    type InsertRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO clients (name, type, plan_id, category_id, contact_email)
      VALUES (
        ${body.name.trim()},
        ${type},
        ${body.planId},
        ${body.categoryId ?? null},
        ${body.contactEmail ?? null}
      )
      RETURNING id, created_at
    `) as unknown as InsertRow[]

    const row = rows[0]!
    return reply.status(201).send({ id: row.id, name: body.name, type, createdAt: row.created_at })
  })

  // ── GET /v1/admin/clients ───────────────────────────────────

  app.get('/clients', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const rows = (await adminDb`
      SELECT c.id, c.name, c.type, c.status, c.plan_id,
             p.name AS plan_name, c.contact_email, c.created_at
      FROM   clients c
      JOIN   plans p ON p.id = c.plan_id
      ORDER BY c.created_at DESC
    `) as unknown as ClientRow[]

    return rows.map(c => ({
      id:           c.id,
      name:         c.name,
      type:         c.type,
      status:       c.status,
      plan:         { id: c.plan_id, name: c.plan_name },
      contactEmail: c.contact_email,
      createdAt:    c.created_at,
    }))
  })

  // ── GET /v1/admin/clients/:id ───────────────────────────────

  app.get('/clients/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }

    const rows = (await adminDb`
      SELECT c.id, c.name, c.type, c.status, c.plan_id,
             p.name AS plan_name, c.contact_email, c.created_at,
             p.monthly_message_cap, p.daily_message_cap, p.hourly_message_cap
      FROM   clients c
      JOIN   plans p ON p.id = c.plan_id
      WHERE  c.id = ${id}
    `) as unknown as (ClientRow & {
      monthly_message_cap: number | null
      daily_message_cap: number | null
      hourly_message_cap: number | null
    })[]

    const client = rows[0]
    if (!client) throw new NotFoundError('Client')

    // Live usage from Redis counters
    const [hourly, daily, monthly] = await Promise.all([
      currentLimit(id, 'hourly'),
      currentLimit(id, 'daily'),
      currentLimit(id, 'monthly'),
    ])

    return {
      id:           client.id,
      name:         client.name,
      type:         client.type,
      status:       client.status,
      plan:         { id: client.plan_id, name: client.plan_name },
      contactEmail: client.contact_email,
      createdAt:    client.created_at,
      usage: {
        messagesThisHour:  { used: hourly,  cap: client.hourly_message_cap  },
        messagesThisDay:   { used: daily,   cap: client.daily_message_cap   },
        messagesThisMonth: { used: monthly, cap: client.monthly_message_cap },
      },
    }
  })

  // ── PATCH /v1/admin/clients/:id ─────────────────────────────

  app.patch('/clients/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const body = req.body as {
      planId?: string
      status?: 'active' | 'suspended'
      contactEmail?: string
    }

    const existing = (await adminDb`SELECT id FROM clients WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('Client')

    if (body.planId) {
      await adminDb`UPDATE clients SET plan_id = ${body.planId}, updated_at = NOW() WHERE id = ${id}`
      await invalidatePlanCache(id)
    }
    if (body.status) {
      await adminDb`UPDATE clients SET status = ${body.status}, updated_at = NOW() WHERE id = ${id}`
    }
    if (body.contactEmail !== undefined) {
      await adminDb`UPDATE clients SET contact_email = ${body.contactEmail}, updated_at = NOW() WHERE id = ${id}`
    }

    return reply.status(204).send()
  })

  // ── POST /v1/admin/clients/:id/api-keys ────────────────────

  app.post('/clients/:id/api-keys', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: clientId } = req.params as { id: string }
    const body = req.body as {
      scopes?: string[]
      environment?: 'live' | 'test'
      expiresAt?: string
    }

    const existing = (await adminDb`SELECT id FROM clients WHERE id = ${clientId}`) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('Client')

    const VALID_SCOPES = new Set(['messaging', 'calls', 'conversations', 'analytics', 'admin'])
    const scopes = (body.scopes ?? ['messaging']).filter(s => VALID_SCOPES.has(s))
    if (scopes.length === 0) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'at least one valid scope is required' })
    }

    const environment: 'live' | 'test' = body.environment === 'test' ? 'test' : 'live'

    // Generate key — raw key is returned once and never stored
    const rawKey  = `era_${randomBytes(24).toString('hex')}`
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const prefix  = rawKey.slice(0, 12)

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null

    type KeyInsertRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO api_keys (client_id, key_hash, key_prefix, environment, scopes, expires_at)
      VALUES (${clientId}, ${keyHash}, ${prefix}, ${environment}, ${scopes}, ${expiresAt})
      RETURNING id, created_at
    `) as unknown as KeyInsertRow[]

    const row = rows[0]!
    return reply.status(201).send({
      id:          row.id,
      key:         rawKey,       // shown ONCE — client must store this
      keyPrefix:   prefix,
      scopes,
      environment,
      expiresAt:   body.expiresAt ?? null,
      createdAt:   row.created_at,
    })
  })

  // ── GET /v1/admin/clients/:id/api-keys ─────────────────────

  app.get('/clients/:id/api-keys', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: clientId } = req.params as { id: string }

    const rows = (await adminDb`
      SELECT id, key_prefix, scopes, environment, status, expires_at, created_at
      FROM   api_keys
      WHERE  client_id = ${clientId}
      ORDER BY created_at DESC
    `) as unknown as ApiKeyRow[]

    return rows.map(k => ({
      id:          k.id,
      keyPrefix:   k.key_prefix,
      scopes:      k.scopes,
      environment: k.environment,
      status:      k.status,
      expiresAt:   k.expires_at,
      createdAt:   k.created_at,
    }))
  })

  // ── DELETE /v1/admin/api-keys/:keyId ───────────────────────

  app.delete('/api-keys/:keyId', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { keyId } = req.params as { keyId: string }

    const rows = (await adminDb`
      UPDATE api_keys SET status = 'revoked' WHERE id = ${keyId} AND status = 'active'
      RETURNING id
    `) as unknown as Array<{ id: string }>

    if (!rows[0]) throw new NotFoundError('API key')

    return reply.status(204).send()
  })
}

export default adminRoutes
