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
import { Redis } from 'ioredis'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'
import { currentLimit } from '../../db/redis.js'
import { invalidatePlanCache } from '../../services/plan.js'
import { NotFoundError, ConflictError } from '../../shared/errors.js'
import { CHANNEL } from '../../queues/definitions.js'

const E164_RE = /^\+[1-9]\d{6,14}$/

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
  ai_enabled: boolean; voice_enabled: boolean; analytics_enabled: boolean
  monthly_message_cap: number | null
  daily_message_cap: number | null
  hourly_message_cap: number | null
  max_sessions: number | null
  billing_model: string
  monthly_fee: string | null
  client_count: string
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
      SELECT p.id, p.name, p.display_name, p.ai_enabled, p.voice_enabled,
             p.analytics_enabled, p.monthly_message_cap, p.daily_message_cap,
             p.hourly_message_cap, p.max_sessions, p.billing_model, p.monthly_fee,
             COUNT(c.id)::text AS client_count
      FROM   plans p
      LEFT JOIN clients c ON c.plan_id = p.id AND c.status = 'active'
      GROUP BY p.id
      ORDER BY p.name
    `) as unknown as PlanRow[]

    return rows.map(p => ({
      id:               p.id,
      name:             p.name,
      displayName:      p.display_name,
      aiEnabled:        p.ai_enabled,
      voiceEnabled:     p.voice_enabled,
      analyticsEnabled: p.analytics_enabled,
      billingModel:     p.billing_model,
      monthlyFee:       p.monthly_fee ? parseFloat(p.monthly_fee) : null,
      limits: {
        monthlyMessages: p.monthly_message_cap,
        dailyMessages:   p.daily_message_cap,
        hourlyMessages:  p.hourly_message_cap,
        maxSessions:     p.max_sessions,
      },
      clientCount: parseInt(p.client_count ?? '0', 10),
    }))
  })

  // ── POST /v1/admin/plans ────────────────────────────────────

  app.post('/plans', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      name?: string; displayName?: string
      aiEnabled?: boolean; voiceEnabled?: boolean; analyticsEnabled?: boolean
      billingModel?: 'none' | 'usage_based' | 'plan_based'
      monthlyFee?: number | null
      monthlyMessageCap?: number | null; dailyMessageCap?: number | null
      hourlyMessageCap?: number | null; maxSessions?: number | null
    }

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name is required' })
    }
    if (!body.displayName?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'displayName is required' })
    }
    if (!body.billingModel || !['none', 'usage_based', 'plan_based'].includes(body.billingModel)) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'billingModel must be none, usage_based, or plan_based' })
    }

    const name = body.name.trim().toLowerCase().replace(/\s+/g, '_')

    try {
      type PlanInsert = { id: string }
      const rows = (await adminDb`
        INSERT INTO plans (
          name, display_name, ai_enabled, voice_enabled, analytics_enabled,
          billing_model, monthly_fee,
          monthly_message_cap, daily_message_cap, hourly_message_cap, max_sessions
        ) VALUES (
          ${name}, ${body.displayName.trim()},
          ${body.aiEnabled ?? true}, ${body.voiceEnabled ?? false}, ${body.analyticsEnabled ?? true},
          ${body.billingModel}, ${body.monthlyFee ?? null},
          ${body.monthlyMessageCap ?? null}, ${body.dailyMessageCap ?? null},
          ${body.hourlyMessageCap ?? null}, ${body.maxSessions ?? null}
        )
        RETURNING id
      `) as unknown as PlanInsert[]

      return reply.status(201).send({
        id: rows[0]!.id, name,
        displayName: body.displayName.trim(),
        aiEnabled: body.aiEnabled ?? true,
        voiceEnabled: body.voiceEnabled ?? false,
        analyticsEnabled: body.analyticsEnabled ?? true,
        billingModel: body.billingModel,
        monthlyFee: body.monthlyFee ?? null,
        limits: {
          monthlyMessages: body.monthlyMessageCap ?? null,
          dailyMessages: body.dailyMessageCap ?? null,
          hourlyMessages: body.hourlyMessageCap ?? null,
          maxSessions: body.maxSessions ?? null,
        },
        clientCount: 0,
      })
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        return reply.status(409).send({ error: 'CONFLICT', message: `A plan named "${name}" already exists` })
      }
      throw err
    }
  })

  // ── PATCH /v1/admin/plans/:id ───────────────────────────────

  app.patch('/plans/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const body = req.body as {
      displayName: string
      aiEnabled: boolean; voiceEnabled: boolean; analyticsEnabled: boolean
      billingModel: 'none' | 'usage_based' | 'plan_based'
      monthlyFee: number | null
      monthlyMessageCap: number | null; dailyMessageCap: number | null
      hourlyMessageCap: number | null; maxSessions: number | null
    }

    const existing = (await adminDb`SELECT id FROM plans WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('Plan')

    await adminDb`
      UPDATE plans SET
        display_name        = ${body.displayName},
        ai_enabled          = ${body.aiEnabled},
        voice_enabled       = ${body.voiceEnabled},
        analytics_enabled   = ${body.analyticsEnabled},
        billing_model       = ${body.billingModel},
        monthly_fee         = ${body.monthlyFee},
        monthly_message_cap = ${body.monthlyMessageCap},
        daily_message_cap   = ${body.dailyMessageCap},
        hourly_message_cap  = ${body.hourlyMessageCap},
        max_sessions        = ${body.maxSessions},
        updated_at          = NOW()
      WHERE id = ${id}
    `

    return reply.status(204).send()
  })

  // ── DELETE /v1/admin/plans/:id ──────────────────────────────

  app.delete('/plans/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }

    const existing = (await adminDb`SELECT id FROM plans WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('Plan')

    const counts = (await adminDb`
      SELECT COUNT(*)::text AS count FROM clients WHERE plan_id = ${id}
    `) as unknown as Array<{ count: string }>
    const n = parseInt(counts[0]?.count ?? '0', 10)
    if (n > 0) {
      return reply.status(409).send({
        error: 'CONFLICT',
        message: `Cannot delete: ${n} business${n !== 1 ? 'es are' : ' is'} on this plan. Reassign them first.`,
      })
    }

    await adminDb`DELETE FROM plans WHERE id = ${id}`
    return reply.status(204).send()
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

  // ── GET /v1/admin/sessions ──────────────────────────────────────
  // All WhatsApp sessions across all clients with warmup + health.

  app.get('/sessions', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    type SessionRow = {
      id: string; phone_number: string; status: string; risk_score: string
      role: string; created_at: string; last_heartbeat_at: Date | null
      messages_sent_total: string; connected_at: Date | null
      cooldown_until: Date | null; client_name: string; client_id: string
      warmup_day: number | null; warmup_complete: boolean | null; skip_warmup: boolean | null
    }

    const rows = (await adminDb`
      SELECT ws.id, ws.phone_number, ws.status, ws.risk_score, ws.role,
             ws.created_at, ws.last_heartbeat_at, ws.messages_sent_total,
             ws.connected_at, ws.cooldown_until,
             c.name AS client_name, c.id AS client_id,
             wp.current_day AS warmup_day, wp.is_complete AS warmup_complete,
             wp.skip_warmup
      FROM   whatsapp_sessions ws
      JOIN   clients c ON c.id = ws.client_id
      LEFT JOIN warmup_profiles wp ON wp.session_id = ws.id
      ORDER BY ws.created_at ASC
    `) as unknown as SessionRow[]

    return rows.map(r => ({
      id:                r.id,
      phoneNumber:       r.phone_number,
      status:            r.status,
      riskScore:         parseFloat(r.risk_score),
      role:              r.role,
      createdAt:         r.created_at,
      lastHeartbeatAt:   r.last_heartbeat_at,
      messagesSentTotal: parseInt(r.messages_sent_total ?? '0', 10),
      connectedAt:       r.connected_at,
      cooldownUntil:     r.cooldown_until,
      client:            { id: r.client_id, name: r.client_name },
      warmup: {
        currentDay:  r.warmup_day,
        isComplete:  r.warmup_complete,
        skipWarmup:  r.skip_warmup,
      },
    }))
  })

  // ── POST /v1/admin/sessions ─────────────────────────────────────
  // Create a new WhatsApp session for a client and start the worker.

  app.post('/sessions', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      clientId?: string; phoneNumber?: string
      role?: 'primary' | 'backup'; primarySessionId?: string
    }

    if (!body.clientId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'clientId is required' })
    }
    const phoneNumber = body.phoneNumber?.trim() ?? ''
    if (!E164_RE.test(phoneNumber)) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Phone number must be in international format, e.g. +2348012345678',
      })
    }

    const existing = (await adminDb`SELECT id FROM clients WHERE id = ${body.clientId}`) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('Client')

    const role: 'primary' | 'backup' = body.role === 'backup' ? 'backup' : 'primary'

    let sessionId: string
    try {
      const rows = (await adminDb`
        INSERT INTO whatsapp_sessions (client_id, phone_number, role, primary_session_id, status)
        VALUES (${body.clientId}, ${phoneNumber}, ${role}, ${body.primarySessionId ?? null}, 'pending_qr')
        RETURNING id
      `) as unknown as Array<{ id: string }>
      sessionId = rows[0]!.id

      await adminDb`
        INSERT INTO warmup_profiles (session_id, client_id)
        VALUES (${sessionId}, ${body.clientId})
      `
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === '23505') throw new ConflictError(`A session for ${phoneNumber} already exists`)
      throw err
    }

    await req.server.supervisor.startSession(sessionId)

    return reply.status(201).send({ id: sessionId, phoneNumber, role, status: 'pending_qr' })
  })

  // ── DELETE /v1/admin/sessions/:id ──────────────────────────────
  // Stop and disconnect a running session.

  app.delete('/sessions/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const rows = (await adminDb`SELECT id FROM whatsapp_sessions WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!rows[0]) throw new NotFoundError('Session')

    await req.server.supervisor.stopSession(id)
    return reply.status(204).send()
  })

  // ── GET /v1/admin/sessions/:id/qr (WebSocket) ──────────────────
  // Streams QR code events for a session. Auth via ?secret= param.

  app.get('/sessions/:id/qr', { websocket: true }, (stream, req) => {
    const ws = stream.socket
    void (async () => {
      const query = req.query as Record<string, string>
      if (!query.secret || query.secret !== config.operatorSecret) {
        ws.close(1008, 'Unauthorized')
        return
      }

      const { id: sessionId } = req.params as { id: string }
      const rows = (await adminDb`SELECT id FROM whatsapp_sessions WHERE id = ${sessionId}`) as unknown as Array<{ id: string }>
      if (!rows[0]) { ws.close(1008, 'Session not found'); return }

      const subscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null })
      await subscriber.subscribe(CHANNEL.sessionQR(sessionId))
      subscriber.on('message', (_ch: string, msg: string) => {
        if (ws.readyState === ws.OPEN) ws.send(msg)
      })
      const cleanup = () => { void subscriber.quit() }
      stream.on('close', cleanup)
      stream.on('error', cleanup)
    })()
  })

  // ── GET /v1/admin/monitoring ────────────────────────────────────
  // System-wide health snapshot for the operator dashboard.

  app.get('/monitoring', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    type AlertRow = { id: string; alert_type: string; severity: string; message: string; created_at: string; resolved_at: Date | null }

    const [allHealth, alerts] = await Promise.all([
      req.server.supervisor.getAllHealth(),
      adminDb`
        SELECT id, alert_type, severity, message, created_at, resolved_at
        FROM   alert_history ORDER BY created_at DESC LIMIT 10
      ` as unknown as Promise<AlertRow[]>,
    ])

    const counts = allHealth.reduce((acc: Record<string, number>, h) => {
      const key = h.status; acc[key] = (acc[key] ?? 0) + 1; return acc
    }, {})

    return {
      sessions: {
        total:        allHealth.length,
        connected:    counts['connected']    ?? 0,
        disconnected: counts['disconnected'] ?? 0,
        flagged:      counts['flagged']      ?? 0,
        banned:       counts['banned']       ?? 0,
      },
      recentAlerts: alerts.map(a => ({
        id:        a.id,
        type:      a.alert_type,
        severity:  a.severity,
        message:   a.message,
        createdAt: a.created_at,
        resolved:  !!a.resolved_at,
      })),
    }
  })

  // ── GET /v1/admin/alerts ────────────────────────────────────────
  // Full alert history for the notification panel.

  app.get('/alerts', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    type AlertHistoryRow = {
      id: string; alert_type: string; severity: string; message: string
      client_id: string | null; session_id: string | null
      resolved_at: Date | null; created_at: string
    }

    const rows = (await adminDb`
      SELECT id, alert_type, severity, message,
             client_id, session_id, resolved_at, created_at
      FROM   alert_history
      ORDER BY created_at DESC
      LIMIT 100
    `) as unknown as AlertHistoryRow[]

    return rows.map(a => ({
      id:         a.id,
      type:       a.alert_type,
      severity:   a.severity,
      message:    a.message,
      clientId:   a.client_id,
      sessionId:  a.session_id,
      resolved:   !!a.resolved_at,
      resolvedAt: a.resolved_at,
      createdAt:  a.created_at,
    }))
  })
}

export default adminRoutes
