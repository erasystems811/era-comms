// ── OPERATOR ADMIN ROUTES ─────────────────────────────────────
//
// ERA Systems operator API — manages clients, plans, sessions, and keys.
// Authentication: X-Operator-Secret header (not client API keys).
//
// Sub-plugins (from ./requests.ts and ./observability.ts) are registered
// at the bottom and inherit the same /v1/admin prefix.

import { randomBytes, createHash, randomInt } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { Redis } from 'ioredis'
import { adminDb } from '../../db/client.js'
import { clearCredentialCache } from '../../sessions/credential-store.js'
import { redis } from '../../db/redis.js'
import { KEY, CHANNEL } from '../../queues/definitions.js'
import { config } from '../../shared/config.js'
import { currentLimit } from '../../db/redis.js'
import { invalidatePlanCache } from '../../services/plan.js'
import { sendMessage } from '../../services/messaging.js'
import { sendEmail, portalAccessEmail, apiKeyEmail } from '../../shared/email.js'
import { NotFoundError, ConflictError } from '../../shared/errors.js'
import { sendSessionCommand } from '../../sessions/supervisor.js'
import requestsRoutes from './requests.js'
import observabilityRoutes from './observability.js'

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

type ClientListRow = {
  id: string; name: string; slug: string | null; type: string; status: string
  plan_id: string; plan_name: string
  contact_email: string | null; contact_phone: string | null
  created_at: string
  session_count: string; monthly_messages: string
}

type SessionRow = {
  id: string; phone_number: string; status: string; risk_score: string
  role: string; created_at: string; last_heartbeat_at: Date | null
  messages_sent_total: string; connected_at: Date | null; cooldown_until: Date | null
  client_name: string; client_id: string
  warmup_day: number | null; warmup_complete: boolean | null; skip_warmup: boolean | null
}

type ApiKeyRow = {
  id: string; client_id: string; label: string; key_prefix: string; scopes: string[]
  environment: string; status: string
  expires_at: string | null; last_used_at: string | null; created_at: string
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
      slug?: string
      type?: 'internal' | 'external'
      planId?: string
      categoryId?: string
      contactEmail?: string
      contactPhone?: string
    }

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name is required' })
    }
    if (!body.planId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'planId is required' })
    }

    const type: 'internal' | 'external' = body.type === 'internal' ? 'internal' : 'external'
    const slug = body.slug?.trim().toLowerCase().replace(/\s+/g, '-') || null

    type InsertRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO clients (name, slug, type, plan_id, category_id, contact_email, contact_phone)
      VALUES (
        ${body.name.trim()},
        ${slug},
        ${type},
        ${body.planId},
        ${body.categoryId ?? null},
        ${body.contactEmail ?? null},
        ${body.contactPhone ?? null}
      )
      RETURNING id, created_at
    `) as unknown as InsertRow[]

    const row = rows[0]!
    return reply.status(201).send({ id: row.id, name: body.name.trim(), type, createdAt: row.created_at })
  })

  // ── GET /v1/admin/clients ───────────────────────────────────

  app.get('/clients', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const rows = (await adminDb`
      SELECT c.id, c.name, c.slug, c.type, c.status, c.plan_id,
             p.name AS plan_name,
             c.contact_email, c.contact_phone,
             c.created_at,
             COUNT(DISTINCT ws.id)::text AS session_count,
             COALESCE(SUM(ws.messages_sent_total), 0)::text AS monthly_messages
      FROM   clients c
      JOIN   plans p ON p.id = c.plan_id
      LEFT JOIN whatsapp_sessions ws ON ws.client_id = c.id
      WHERE  c.type != 'internal'
      GROUP BY c.id, p.name
      ORDER BY c.created_at DESC
    `) as unknown as ClientListRow[]

    return rows.map(c => ({
      id:                  c.id,
      name:                c.name,
      slug:                c.slug ?? c.id.slice(0, 8),
      planId:              c.plan_id,
      planName:            c.plan_name,
      active:              c.status === 'active',
      sessionCount:        parseInt(c.session_count ?? '0', 10),
      monthlyMessageCount: parseInt(c.monthly_messages ?? '0', 10),
      createdAt:           c.created_at,
      contactEmail:        c.contact_email,
      contactPhone:        c.contact_phone,
    }))
  })

  // ── GET /v1/admin/clients/:id ───────────────────────────────

  app.get('/clients/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }

    type ClientDetailRow = {
      id: string; name: string; slug: string | null; type: string; status: string
      plan_id: string; plan_name: string; plan_display: string
      plan_billing_model: string; plan_monthly_fee: string | null
      plan_monthly_cap: number | null; plan_daily_cap: number | null
      plan_hourly_cap: number | null; plan_max_sessions: number | null
      plan_ai_enabled: boolean; plan_voice_enabled: boolean; plan_analytics_enabled: boolean
      contact_email: string | null; contact_phone: string | null
      created_at: string
      session_count: string; monthly_messages: string
    }

    const rows = (await adminDb`
      SELECT c.id, c.name, c.slug, c.type, c.status, c.plan_id,
             p.name AS plan_name, p.display_name AS plan_display,
             p.billing_model AS plan_billing_model, p.monthly_fee AS plan_monthly_fee,
             p.monthly_message_cap AS plan_monthly_cap, p.daily_message_cap AS plan_daily_cap,
             p.hourly_message_cap AS plan_hourly_cap, p.max_sessions AS plan_max_sessions,
             p.ai_enabled AS plan_ai_enabled, p.voice_enabled AS plan_voice_enabled,
             p.analytics_enabled AS plan_analytics_enabled,
             c.contact_email, c.contact_phone, c.created_at,
             COUNT(DISTINCT ws.id)::text AS session_count,
             COALESCE(SUM(ws.messages_sent_total), 0)::text AS monthly_messages
      FROM   clients c
      JOIN   plans p ON p.id = c.plan_id
      LEFT JOIN whatsapp_sessions ws ON ws.client_id = c.id
      WHERE  c.id = ${id} AND c.type != 'internal'
      GROUP BY c.id, p.id
    `) as unknown as ClientDetailRow[]

    const client = rows[0]
    if (!client) throw new NotFoundError('Client')

    type ClientSessionRow = {
      id: string; phone_number: string; status: string; risk_score: string
      role: string; created_at: string; last_heartbeat_at: Date | null
      messages_sent_total: string; connected_at: Date | null; cooldown_until: Date | null
      warmup_day: number | null; warmup_complete: boolean | null; skip_warmup: boolean | null
    }

    const sessionRows = (await adminDb`
      SELECT ws.id, ws.phone_number, ws.status, ws.risk_score, ws.role,
             ws.created_at, ws.last_heartbeat_at, ws.messages_sent_total,
             ws.connected_at, ws.cooldown_until,
             wp.current_day AS warmup_day, wp.is_complete AS warmup_complete, wp.skip_warmup
      FROM   whatsapp_sessions ws
      LEFT JOIN warmup_profiles wp ON wp.session_id = ws.id
      WHERE  ws.client_id = ${id}
      ORDER BY ws.created_at ASC
    `) as unknown as ClientSessionRow[]

    const keyRows = (await adminDb`
      SELECT id, client_id, label, key_prefix, scopes, environment, status, expires_at, last_used_at, created_at
      FROM   api_keys
      WHERE  client_id = ${id}
      ORDER BY created_at DESC
    `) as unknown as ApiKeyRow[]

    const monthly = await currentLimit(id, 'monthly')
    const sessionsActive = sessionRows.filter(s => s.status === 'connected').length

    return {
      id:                  client.id,
      name:                client.name,
      slug:                client.slug ?? client.id.slice(0, 8),
      planId:              client.plan_id,
      planName:            client.plan_name,
      active:              client.status === 'active',
      sessionCount:        parseInt(client.session_count ?? '0', 10),
      monthlyMessageCount: parseInt(client.monthly_messages ?? '0', 10),
      createdAt:           client.created_at,
      contactEmail:        client.contact_email,
      contactPhone:        client.contact_phone,
      plan: {
        id:               client.plan_id,
        name:             client.plan_name,
        displayName:      client.plan_display,
        aiEnabled:        client.plan_ai_enabled,
        voiceEnabled:     client.plan_voice_enabled,
        analyticsEnabled: client.plan_analytics_enabled,
        billingModel:     client.plan_billing_model,
        monthlyFee:       client.plan_monthly_fee ? parseFloat(client.plan_monthly_fee) : null,
        limits: {
          monthlyMessages: client.plan_monthly_cap,
          dailyMessages:   client.plan_daily_cap,
          hourlyMessages:  client.plan_hourly_cap,
          maxSessions:     client.plan_max_sessions,
        },
        clientCount: 0,
      },
      sessions: sessionRows.map(r => ({
        id:                r.id,
        phoneNumber:       r.phone_number,
        status:            r.status === 'active' ? 'connected' : r.status,
        riskScore:         parseFloat(r.risk_score),
        role:              r.role,
        createdAt:         r.created_at,
        lastHeartbeatAt:   r.last_heartbeat_at,
        messagesSentTotal: parseInt(r.messages_sent_total ?? '0', 10),
        connectedAt:       r.connected_at,
        cooldownUntil:     r.cooldown_until,
        client:            { id: client.id, name: client.name },
        warmup: { currentDay: r.warmup_day, isComplete: r.warmup_complete, skipWarmup: r.skip_warmup },
      })),
      apiKeys: keyRows.map(k => ({
        id:         k.id,
        clientId:   k.client_id,
        label:      k.label,
        keyPreview: k.key_prefix,
        scopes:     k.scopes,
        active:     k.status === 'active',
        lastUsedAt: k.last_used_at,
        createdAt:  k.created_at,
      })),
      usage: { monthlyMessages: monthly, sessionsActive },
    }
  })

  // ── PATCH /v1/admin/clients/:id ─────────────────────────────

  app.patch('/clients/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const body = req.body as {
      planId?: string
      status?: 'active' | 'suspended'
      active?: boolean
      name?: string
      contactEmail?: string
      contactPhone?: string
    }

    const existing = (await adminDb`SELECT id FROM clients WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!existing[0]) throw new NotFoundError('Client')

    if (body.planId) {
      await adminDb`UPDATE clients SET plan_id = ${body.planId}, updated_at = NOW() WHERE id = ${id}`
      await invalidatePlanCache(id)
    }
    const newStatus = body.status
      ?? (body.active !== undefined ? (body.active ? 'active' : 'suspended') : undefined)
    if (newStatus) {
      await adminDb`UPDATE clients SET status = ${newStatus}, updated_at = NOW() WHERE id = ${id}`
    }
    if (body.name?.trim()) {
      await adminDb`UPDATE clients SET name = ${body.name.trim()}, updated_at = NOW() WHERE id = ${id}`
    }
    if (body.contactEmail !== undefined) {
      await adminDb`UPDATE clients SET contact_email = ${body.contactEmail}, updated_at = NOW() WHERE id = ${id}`
    }
    if (body.contactPhone !== undefined) {
      await adminDb`UPDATE clients SET contact_phone = ${body.contactPhone}, updated_at = NOW() WHERE id = ${id}`
    }

    return reply.status(204).send()
  })

  // ── DELETE /v1/admin/clients/:id ────────────────────────────

  app.delete('/clients/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const rows = (await adminDb`SELECT id FROM clients WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!rows[0]) throw new NotFoundError('Client')

    await adminDb`DELETE FROM clients WHERE id = ${id}`
    return reply.status(204).send()
  })

  // ── POST /v1/admin/clients/:id/api-keys ────────────────────

  app.post('/clients/:id/api-keys', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: clientId } = req.params as { id: string }
    const body = req.body as {
      scopes?: string[]
      environment?: 'live' | 'test'
      label?: string
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

    const rawKey  = `era_${randomBytes(24).toString('hex')}`
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const prefix  = rawKey.slice(0, 12)
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null

    const label = body.label?.trim() ?? ''

    type KeyInsertRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO api_keys (client_id, key_hash, key_prefix, label, environment, scopes, expires_at)
      VALUES (${clientId}, ${keyHash}, ${prefix}, ${label}, ${environment}, ${scopes}, ${expiresAt})
      RETURNING id, created_at
    `) as unknown as KeyInsertRow[]

    const row = rows[0]!
    return reply.status(201).send({
      id:        row.id,
      key:       rawKey,
      label,
      keyPreview: prefix,
      scopes,
      environment,
      expiresAt: body.expiresAt ?? null,
      createdAt: row.created_at,
    })
  })

  // ── GET /v1/admin/clients/:id/api-keys ─────────────────────

  app.get('/clients/:id/api-keys', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: clientId } = req.params as { id: string }

    const rows = (await adminDb`
      SELECT id, client_id, label, key_prefix, scopes, environment, status, expires_at, last_used_at, created_at
      FROM   api_keys
      WHERE  client_id = ${clientId}
      ORDER BY created_at DESC
    `) as unknown as ApiKeyRow[]

    return rows.map(k => ({
      id:         k.id,
      clientId:   k.client_id,
      label:      k.environment,
      keyPreview: k.key_prefix,
      scopes:     k.scopes,
      active:     k.status === 'active',
      lastUsedAt: k.last_used_at,
      createdAt:  k.created_at,
    }))
  })

  // ── DELETE /v1/admin/api-keys/:keyId ───────────────────────

  app.delete('/api-keys/:keyId', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { keyId } = req.params as { keyId: string }

    const rows = (await adminDb`
      DELETE FROM api_keys WHERE id = ${keyId}
      RETURNING id
    `) as unknown as Array<{ id: string }>

    if (!rows[0]) throw new NotFoundError('API key')

    return reply.status(204).send()
  })

  // ── POST /v1/admin/clients/:clientId/api-keys/:keyId/send-secure-link ──

  app.post('/clients/:clientId/api-keys/:keyId/send-secure-link', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { clientId, keyId } = req.params as { clientId: string; keyId: string }

    const clients = (await adminDb`
      SELECT id, contact_email, name FROM clients WHERE id = ${clientId}
    `) as unknown as Array<{ id: string; contact_email: string | null; name: string }>
    if (!clients[0]) throw new NotFoundError('Client')

    const keys = (await adminDb`
      SELECT id, label FROM api_keys WHERE id = ${keyId} AND client_id = ${clientId} AND status = 'active'
    `) as unknown as Array<{ id: string; label: string }>
    if (!keys[0]) throw new NotFoundError('API key')

    const client = clients[0]!
    const key    = keys[0]!

    // Rotate the key — generate a fresh one and update the hash in the DB.
    // The previous key is immediately invalidated.
    const rawKey  = `era_${randomBytes(24).toString('hex')}`
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const prefix  = rawKey.slice(0, 12)

    await adminDb`
      UPDATE api_keys
      SET key_hash = ${keyHash}, key_prefix = ${prefix}, updated_at = NOW()
      WHERE id = ${keyId}
    `

    // Create a one-time reveal token valid for 7 days
    const revealToken = randomBytes(32).toString('hex')

    await adminDb`
      INSERT INTO api_key_reveal_tokens (token, api_key_id, key_value, label, client_name)
      VALUES (${revealToken}, ${keyId}, ${rawKey}, ${key.label}, ${client.name})
    `

    const hubUrl    = config.isProduction ? 'https://hub.erasystems.com.ng' : 'http://localhost:5173'
    const revealUrl = `${hubUrl}/reveal-key/${revealToken}`

    if (client.contact_email) {
      sendEmail(apiKeyEmail({
        businessName: client.name,
        email:        client.contact_email,
        revealUrl,
        keyLabel:     key.label || 'API Key',
      })).catch(err => req.log.error({ err }, 'API key email failed'))
    }

    await adminDb`
      INSERT INTO audit_log (actor, actor_label, action, target, target_id, detail)
      VALUES ('operator', 'ERA Systems', 'sent_api_key_link', 'api_key', ${keyId},
        ${'One-time reveal link sent to ' + (client.contact_email ?? 'no email on file')})
    `

    return reply.status(204).send()
  })


  // ── GET /v1/admin/sessions ──────────────────────────────────

  app.get('/sessions', async (req, reply) => {
    if (!assertOperator(req, reply)) return

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
      status:            r.status === 'active' ? 'connected' : r.status,
      riskScore:         parseFloat(r.risk_score),
      role:              r.role,
      createdAt:         r.created_at,
      lastHeartbeatAt:   r.last_heartbeat_at,
      messagesSentTotal: parseInt(r.messages_sent_total ?? '0', 10),
      connectedAt:       r.connected_at,
      cooldownUntil:     r.cooldown_until,
      client:            { id: r.client_id, name: r.client_name },
      warmup: { currentDay: r.warmup_day, isComplete: r.warmup_complete, skipWarmup: r.skip_warmup },
    }))
  })

  // ── GET /v1/admin/sessions/master ──────────────────────────
  // ERA Systems own WhatsApp session (type='internal' client) used for OTPs.

  app.get('/sessions/master', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const rows = (await adminDb`
      SELECT ws.id, ws.phone_number, ws.status, ws.risk_score, ws.role,
             ws.created_at, ws.last_heartbeat_at, ws.messages_sent_total,
             ws.connected_at, ws.cooldown_until,
             c.name AS client_name, c.id AS client_id,
             wp.current_day AS warmup_day, wp.is_complete AS warmup_complete, wp.skip_warmup
      FROM   whatsapp_sessions ws
      JOIN   clients c ON c.id = ws.client_id AND c.type = 'internal'
      LEFT JOIN warmup_profiles wp ON wp.session_id = ws.id
      ORDER BY ws.created_at ASC
      LIMIT 1
    `) as unknown as SessionRow[]

    if (!rows[0]) return reply.send(null)

    const r = rows[0]
    return {
      id: r.id, phoneNumber: r.phone_number, status: r.status,
      riskScore: parseFloat(r.risk_score), role: r.role,
      createdAt: r.created_at, lastHeartbeatAt: r.last_heartbeat_at,
      messagesSentTotal: parseInt(r.messages_sent_total ?? '0', 10),
      connectedAt: r.connected_at, cooldownUntil: r.cooldown_until,
      client: { id: r.client_id, name: r.client_name },
      warmup: { currentDay: r.warmup_day, isComplete: r.warmup_complete, skipWarmup: r.skip_warmup },
    }
  })

  // ── POST /v1/admin/sessions ─────────────────────────────────

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

  // ── POST /v1/admin/sessions/otp/send ───────────────────────

  app.post('/sessions/otp/send', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as { phoneNumber?: string; email?: string }
    if (!body.phoneNumber) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'phoneNumber is required' })
    }

    const code = String(randomInt(100000, 999999))
    const rows = (await adminDb`
      INSERT INTO otp_sessions (phone_number, code) VALUES (${body.phoneNumber}, ${code}) RETURNING id
    `) as unknown as Array<{ id: string }>

    const otpId = rows[0]!.id

    // Try email delivery first (most reliable)
    if (body.email) {
      sendEmail({
        to:      body.email,
        subject: `ERA Comms — Your verification code: ${code}`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f0d17;font-family:system-ui,sans-serif;color:#e2e0ef">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:40px auto">
    <tr><td style="padding:32px">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:700;color:#bf7c93">ERA</span>
        <span style="font-size:20px;font-weight:700;color:#e2e0ef"> Comms</span>
      </div>
      <h1 style="font-size:18px;font-weight:700;color:#e2e0ef;margin:0 0 8px">Your verification code</h1>
      <p style="color:#8b8a9b;margin:0 0 24px;font-size:14px">Use this code to verify WhatsApp number <strong style="color:#e2e0ef">${body.phoneNumber}</strong></p>
      <div style="background:#1a1729;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <p style="font-size:40px;font-weight:700;letter-spacing:0.3em;color:#bf7c93;margin:0;font-family:monospace">${code}</p>
      </div>
      <p style="font-size:12px;color:#4a4958">Expires in 10 minutes. Do not share this code with anyone.</p>
    </td></tr>
  </table>
</body>
</html>`,
        text: `Your ERA Comms verification code is: ${code}\n\nThis code expires in 10 minutes.`,
      }).catch(err => req.log.error({ err }, 'OTP email delivery failed'))
    }

    // Also try WhatsApp if an internal session is connected
    const internalClientId = config.monitoring.operatorInternalClientId
    if (internalClientId) {
      const sessions = (await adminDb`
        SELECT id FROM whatsapp_sessions
        WHERE  client_id = ${internalClientId} AND status = 'connected'
        ORDER BY created_at ASC LIMIT 1
      `) as unknown as Array<{ id: string }>

      if (sessions[0]) {
        sendMessage({
          clientId:   internalClientId,
          sessionId:  sessions[0].id,
          to:         body.phoneNumber,
          content:    `Your ERA Comms verification code is: *${code}*\n\nExpires in 10 minutes.`,
          aiGenerated: false,
        }).catch(err => req.log.error({ err }, 'OTP WhatsApp delivery failed'))
      }
    }

    if (!body.email) {
      req.log.warn({ phoneNumber: body.phoneNumber, code }, 'OTP generated — no email provided and no WhatsApp session, code logged only')
    }

    return reply.status(201).send({ otpId })
  })

  // ── POST /v1/admin/sessions/otp/verify ─────────────────────

  app.post('/sessions/otp/verify', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as { otpId?: string; code?: string }
    if (!body.otpId || !body.code) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'otpId and code are required' })
    }

    const rows = (await adminDb`
      SELECT id, code, phone_number, used, expires_at FROM otp_sessions WHERE id = ${body.otpId}
    `) as unknown as Array<{ id: string; code: string; phone_number: string; used: boolean; expires_at: Date }>

    const otp = rows[0]
    if (!otp) return reply.status(404).send({ error: 'NOT_FOUND', message: 'OTP session not found' })
    if (otp.used) return reply.status(400).send({ error: 'OTP_USED', message: 'This OTP has already been used' })
    if (new Date() > new Date(otp.expires_at)) {
      return reply.status(400).send({ error: 'OTP_EXPIRED', message: 'OTP has expired. Request a new one.' })
    }
    if (otp.code !== body.code) {
      return reply.status(400).send({ error: 'INVALID_CODE', message: 'Incorrect code. Please try again.' })
    }

    await adminDb`UPDATE otp_sessions SET used = TRUE WHERE id = ${body.otpId}`

    const sessions = (await adminDb`
      SELECT id FROM whatsapp_sessions WHERE phone_number = ${otp.phone_number} ORDER BY created_at DESC LIMIT 1
    `) as unknown as Array<{ id: string }>

    return reply.send({ sessionId: sessions[0]?.id ?? null, verified: true, phoneNumber: otp.phone_number })
  })

  // ── DELETE /v1/admin/sessions/:id ──────────────────────────

  app.delete('/sessions/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const rows = (await adminDb`SELECT id FROM whatsapp_sessions WHERE id = ${id}`) as unknown as Array<{ id: string }>
    if (!rows[0]) throw new NotFoundError('Session')

    await req.server.supervisor.stopSession(id)
    return reply.status(204).send()
  })

  // ── PATCH /v1/admin/sessions/:id/profile ───────────────────

  app.patch('/sessions/:id/profile', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: sessionId } = req.params as { id: string }
    const body = req.body as {
      name?: string | null
      description?: string | null
      pictureUrl?: string | null
    }

    const rows = (await adminDb`SELECT id, status FROM whatsapp_sessions WHERE id = ${sessionId}`) as unknown as Array<{ id: string; status: string }>
    if (!rows[0]) throw new NotFoundError('Session')

    await adminDb`
      UPDATE whatsapp_sessions
      SET profile_name        = ${body.name        ?? null},
          profile_description = ${body.description ?? null},
          profile_picture_url = ${body.pictureUrl  ?? null},
          updated_at          = NOW()
      WHERE id = ${sessionId}
    `

    // If session is active, push the profile to WhatsApp immediately
    if (rows[0].status === 'active') {
      await sendSessionCommand(sessionId, {
        command: 'set_profile',
        name:        body.name,
        description: body.description,
        pictureUrl:  body.pictureUrl,
      })
    }

    return reply.send({ ok: true })
  })

  // ── POST /v1/admin/sessions/:id/unban ───────────────────────
  // Reset a spuriously-banned session back to disconnected so it can reconnect.

  app.post('/sessions/:id/unban', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id: sessionId } = req.params as { id: string }
    await adminDb`
      UPDATE whatsapp_sessions
      SET status = 'disconnected', updated_at = NOW()
      WHERE id = ${sessionId} AND status = 'banned'
    `
    return reply.send({ ok: true })
  })

  // ── POST /v1/admin/sessions/:id/test-message ────────────────
  // Send a test WhatsApp message directly from the operator hub.

  app.post('/sessions/:id/test-message', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: sessionId } = req.params as { id: string }
    const { to, content } = req.body as { to?: string; content?: string }

    if (!to || !E164_RE.test(to))
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'to must be E.164 (e.g. +2348012345678)' })
    if (!content?.trim())
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'content is required' })

    type SessionRow = { client_id: string; status: string }
    const rows = (await adminDb`SELECT client_id, status FROM whatsapp_sessions WHERE id = ${sessionId}`) as unknown as SessionRow[]
    if (!rows[0]) throw new NotFoundError('Session')

    if (rows[0].status !== 'active') {
      return reply.status(409).send({
        error: 'SESSION_NOT_CONNECTED',
        message: `Session is not connected (status: ${rows[0].status}) — reconnect it first`,
      })
    }

    const result = await sendMessage({
      clientId:    rows[0].client_id,
      sessionId,
      to,
      content,
      contentType: 'text',
      skipJitter:  true,
    })

    return reply.send({ ok: true, messageId: result.messageId })
  })

  // ── POST /v1/admin/sessions/:id/reset-credentials ───────────
  // Wipes corrupted WhatsApp credentials → forces fresh QR scan.

  app.post('/sessions/:id/reset-credentials', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: sessionId } = req.params as { id: string }

    const rows = (await adminDb`SELECT id FROM whatsapp_sessions WHERE id = ${sessionId}`) as unknown as Array<{ id: string }>
    if (!rows[0]) throw new NotFoundError('Session')

    // Wipe ALL Redis keys for this session (creds + signal keys)
    await clearCredentialCache(sessionId)
    const allKeys = await redis.keys(`session:${sessionId}:*`)
    if (allKeys.length > 0) await redis.del(...allKeys)

    await adminDb`
      UPDATE whatsapp_sessions
      SET credentials_encrypted  = NULL,
          credentials_iv         = NULL,
          credentials_tag        = NULL,
          credentials_updated_at = NULL,
          status                 = 'disconnected'
      WHERE id = ${sessionId}
    `

    // Reconnect so the worker restarts and generates a fresh QR
    await sendSessionCommand(sessionId, { command: 'reconnect' })

    return reply.send({ ok: true })
  })

  // ── POST /v1/admin/sessions/:id/pairing-code ─────────────────
  // Request a WhatsApp pairing code (OTP alternative to QR scanning).

  app.post('/sessions/:id/pairing-code', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id: sessionId } = req.params as { id: string }
    const { phoneNumber } = req.body as { phoneNumber?: string }
    if (!phoneNumber) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'phoneNumber is required' })

    const rows = (await adminDb`SELECT id FROM whatsapp_sessions WHERE id = ${sessionId}`) as unknown as Array<{ id: string }>
    if (!rows[0]) throw new NotFoundError('Session')

    // Subscribe to the result channel before sending the command to avoid a race
    const sub = new Redis(config.redis.url, { maxRetriesPerRequest: null })
    const resultChannel = CHANNEL.pairingCodeResult(sessionId)

    const codePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.unsubscribe(resultChannel).then(() => sub.disconnect()).catch(() => {})
        reject(new Error('Pairing code request timed out — ensure the session is running'))
      }, 15_000)

      sub.subscribe(resultChannel, (err) => {
        if (err) { clearTimeout(timeout); reject(err) }
      })

      sub.on('message', (_ch, msg) => {
        clearTimeout(timeout)
        void sub.unsubscribe(resultChannel).then(() => sub.disconnect())
        const result = JSON.parse(msg) as { ok: boolean; code?: string; error?: string }
        if (result.ok && result.code) resolve(result.code)
        else reject(new Error(result.error ?? 'Failed to get pairing code'))
      })
    })

    await sendSessionCommand(sessionId, { command: 'request_pairing_code', phoneNumber })

    const code = await codePromise
    return reply.send({ code })
  })

  // ── GET /v1/admin/sessions/:id/qr (WebSocket) ──────────────

  app.get('/sessions/:id/qr', { websocket: true }, (stream, req) => {
    const ws = stream.socket
    void (async () => {
      const query = req.query as Record<string, string>
      if (!query.secret || query.secret !== config.operatorSecret) {
        ws.close(1008, 'Unauthorized')
        return
      }

      const { id: sessionId } = req.params as { id: string }
      const rows = (await adminDb`SELECT id, status FROM whatsapp_sessions WHERE id = ${sessionId}`) as unknown as Array<{ id: string; status: string }>
      if (!rows[0]) { ws.close(1008, 'Session not found'); return }

      // Subscribe BEFORE restarting — avoids a race where the QR is published
      // between the restart and the subscribe call.
      const subscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null })
      await subscriber.subscribe(CHANNEL.sessionQR(sessionId))
      subscriber.on('message', (_ch: string, msg: string) => {
        if (ws.readyState === ws.OPEN) ws.send(msg)
      })
      const cleanup = () => { void subscriber.quit() }
      stream.on('close', cleanup)
      stream.on('error', cleanup)

      // If the session is not currently active, clear stale credentials and
      // restart the worker so Baileys starts fresh and generates a new QR.
      // Partially-initialised credentials (keys generated but QR never scanned)
      // cause an immediate disconnect on reconnect — clearing them fixes this.
      if (rows[0].status !== 'active') {
        await clearCredentialCache(sessionId)
        await adminDb`
          UPDATE whatsapp_sessions
          SET credentials_encrypted = NULL, credentials_iv = NULL, credentials_tag = NULL
          WHERE id = ${sessionId}
        `
        await req.server.supervisor.stopSession(sessionId)
        await req.server.supervisor.startSession(sessionId)
      }
    })()
  })

  // ── GET /v1/admin/monitoring ────────────────────────────────

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

  // ── GET /v1/admin/monitoring/snapshot ──────────────────────
  // Live system health snapshot consumed by the CommsDashboard page.

  app.get('/monitoring/snapshot', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const allHealth = await req.server.supervisor.getAllHealth()

    const counts = allHealth.reduce((acc: Record<string, number>, h) => {
      acc[h.status] = (acc[h.status] ?? 0) + 1; return acc
    }, {})

    type EventCountRow = { event_type: string; total: string }
    type CountRow = { total: string }

    // platform_events may not exist until migration 002 runs
    let evRows: EventCountRow[] = []
    try {
      evRows = (await adminDb`
        SELECT event_type, COUNT(*)::text AS total
        FROM platform_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY event_type
      `) as unknown as EventCountRow[]
    } catch { /* table not yet created */ }

    const msgIn  = evRows.filter(r => r.event_type === 'message_received').reduce((s, r) => s + parseInt(r.total), 0)
    const msgOut = evRows.filter(r => r.event_type === 'message_sent').reduce((s, r) => s + parseInt(r.total), 0)

    const [convRows, handoffRows, criticalRows, warningRows] = await Promise.all([
      adminDb`SELECT COUNT(*)::text AS total FROM conversations WHERE ai_active = TRUE AND status = 'active'` as unknown as Promise<CountRow[]>,
      adminDb`SELECT COUNT(*)::text AS total FROM conversations WHERE status = 'escalated'` as unknown as Promise<CountRow[]>,
      adminDb`SELECT COUNT(*)::text AS total FROM alert_history WHERE resolved_at IS NULL AND severity = 'critical'` as unknown as Promise<CountRow[]>,
      adminDb`SELECT COUNT(*)::text AS total FROM alert_history WHERE resolved_at IS NULL AND severity = 'warning'` as unknown as Promise<CountRow[]>,
    ])

    return {
      sessions: {
        total:        allHealth.length,
        connected:    counts['connected']    ?? 0,
        disconnected: counts['disconnected'] ?? 0,
        warning:      (counts['flagged'] ?? 0) + (counts['cooldown'] ?? 0),
      },
      messages: {
        lastHour:   msgIn + msgOut,
        today:      msgIn + msgOut,
        processing: 0,
      },
      ai: {
        activeConversations: parseInt(convRows[0]?.total ?? '0', 10),
        handoffsInProgress:  parseInt(handoffRows[0]?.total ?? '0', 10),
        errorsLastHour:      0,
      },
      alerts: {
        critical: parseInt(criticalRows[0]?.total ?? '0', 10),
        warning:  parseInt(warningRows[0]?.total ?? '0', 10),
      },
      updatedAt: new Date().toISOString(),
    }
  })

  // ── GET /v1/admin/alerts ────────────────────────────────────

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

  // ── GET /v1/admin/platform-alerts ──────────────────────────
  // Full alert list with optional ?resolved=true|false filter.

  app.get('/platform-alerts', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const query = req.query as { resolved?: string }
    const resolvedFilter = query.resolved === 'true' ? true : query.resolved === 'false' ? false : null

    type AlertRow = {
      id: string; alert_type: string; severity: string; message: string
      client_id: string | null; client_name: string | null
      session_id: string | null; resolved_at: Date | null; created_at: string
    }

    let rows: AlertRow[]
    if (resolvedFilter === null) {
      rows = (await adminDb`
        SELECT ah.id, ah.alert_type, ah.severity, ah.message,
               ah.client_id, c.name AS client_name, ah.session_id, ah.resolved_at, ah.created_at
        FROM alert_history ah LEFT JOIN clients c ON c.id = ah.client_id
        ORDER BY ah.created_at DESC LIMIT 200
      `) as unknown as AlertRow[]
    } else if (resolvedFilter) {
      rows = (await adminDb`
        SELECT ah.id, ah.alert_type, ah.severity, ah.message,
               ah.client_id, c.name AS client_name, ah.session_id, ah.resolved_at, ah.created_at
        FROM alert_history ah LEFT JOIN clients c ON c.id = ah.client_id
        WHERE ah.resolved_at IS NOT NULL
        ORDER BY ah.created_at DESC LIMIT 100
      `) as unknown as AlertRow[]
    } else {
      rows = (await adminDb`
        SELECT ah.id, ah.alert_type, ah.severity, ah.message,
               ah.client_id, c.name AS client_name, ah.session_id, ah.resolved_at, ah.created_at
        FROM alert_history ah LEFT JOIN clients c ON c.id = ah.client_id
        WHERE ah.resolved_at IS NULL
        ORDER BY ah.created_at DESC LIMIT 100
      `) as unknown as AlertRow[]
    }

    return rows.map(a => ({
      id:           a.id,
      type:         a.alert_type,
      severity:     a.severity,
      message:      a.message,
      businessId:   a.client_id,
      businessName: a.client_name,
      sessionId:    a.session_id,
      resolved:     !!a.resolved_at,
      resolvedAt:   a.resolved_at,
      createdAt:    a.created_at,
    }))
  })

  // ── POST /v1/admin/platform-alerts/:id/resolve ─────────────

  app.post('/platform-alerts/:id/resolve', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const rows = (await adminDb`
      UPDATE alert_history SET resolved_at = NOW()
      WHERE id = ${id} AND resolved_at IS NULL RETURNING id
    `) as unknown as Array<{ id: string }>
    if (!rows[0]) throw new NotFoundError('Alert')
    return reply.status(204).send()
  })

  // ── GET /v1/admin/ai-config ─────────────────────────────────

  app.get('/ai-config', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    type SettingsRow = {
      ai_temperature: string; ai_system_prompt: string
      ai_max_requests_per_hour: number; ai_max_tokens_per_response: number
      ai_daily_spend_cutoff: string
    }

    const rows = (await adminDb`SELECT * FROM operator_settings WHERE id = 'global'`) as unknown as SettingsRow[]
    const row  = rows[0]
    if (!row) {
      return {
        temperature: 0.7, systemPrompt: '', maxRequestsPerHour: 100,
        maxTokensPerResponse: 1000, dailySpendCutoff: 5000,
      }
    }
    return {
      temperature:          parseFloat(row.ai_temperature),
      systemPrompt:         row.ai_system_prompt,
      maxRequestsPerHour:   row.ai_max_requests_per_hour,
      maxTokensPerResponse: row.ai_max_tokens_per_response,
      dailySpendCutoff:     parseFloat(row.ai_daily_spend_cutoff),
    }
  })

  // ── PUT /v1/admin/ai-config ──────────────────────────────────

  app.put('/ai-config', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      temperature?: number; systemPrompt?: string
      maxRequestsPerHour?: number; maxTokensPerResponse?: number
      dailySpendCutoff?: number
    }

    await adminDb`
      INSERT INTO operator_settings (id, ai_temperature, ai_system_prompt,
        ai_max_requests_per_hour, ai_max_tokens_per_response, ai_daily_spend_cutoff)
      VALUES ('global',
        ${body.temperature          ?? 0.7},
        ${body.systemPrompt         ?? ''},
        ${body.maxRequestsPerHour   ?? 100},
        ${body.maxTokensPerResponse ?? 1000},
        ${body.dailySpendCutoff     ?? 5000})
      ON CONFLICT (id) DO UPDATE SET
        ai_temperature              = EXCLUDED.ai_temperature,
        ai_system_prompt            = EXCLUDED.ai_system_prompt,
        ai_max_requests_per_hour    = EXCLUDED.ai_max_requests_per_hour,
        ai_max_tokens_per_response  = EXCLUDED.ai_max_tokens_per_response,
        ai_daily_spend_cutoff       = EXCLUDED.ai_daily_spend_cutoff,
        updated_at                  = NOW()
    `
    return reply.status(204).send()
  })

  // ── AI REPLY PROFILE per client ─────────────────────────────

  app.get('/clients/:clientId/ai-profile', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.params as { clientId: string }

    type PRow = {
      id: string; persona: string; tone: string; system_prompt: string
      permitted_topics: string[]; prohibited_topics: string[]
      escalation_triggers: string[]; max_tokens: number; temperature: number
      ai_reply: boolean
    }

    const profiles = (await adminDb`
      SELECT p.*, COALESCE(m.ai_reply, FALSE) AS ai_reply
      FROM   ai_reply_profiles p
      LEFT JOIN module_config m ON m.client_id = p.client_id
      WHERE  p.client_id = ${clientId}
    `) as unknown as PRow[]

    if (!profiles[0]) {
      // Return defaults so the UI can pre-fill
      return reply.send({
        exists: false, aiReply: false,
        persona: 'a helpful business assistant',
        tone: 'friendly and professional',
        systemPrompt: "You are a helpful business assistant. Be concise and professional. Only answer questions related to this business. If you don't know something, offer to connect the customer with a human.",
        permittedTopics: [], prohibitedTopics: [],
        escalationTriggers: ['human', 'agent', 'speak to someone', 'call me', 'complaint', 'refund'],
        maxTokens: 500, temperature: 0.7,
      })
    }

    const p = profiles[0]!
    return reply.send({
      exists: true, aiReply: p.ai_reply,
      persona: p.persona, tone: p.tone, systemPrompt: p.system_prompt,
      permittedTopics: p.permitted_topics, prohibitedTopics: p.prohibited_topics,
      escalationTriggers: p.escalation_triggers,
      maxTokens: p.max_tokens, temperature: Number(p.temperature),
    })
  })

  app.put('/clients/:clientId/ai-profile', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.params as { clientId: string }

    const b = req.body as {
      aiReply?: boolean; persona?: string; tone?: string; systemPrompt?: string
      permittedTopics?: string[]; prohibitedTopics?: string[]
      escalationTriggers?: string[]; maxTokens?: number; temperature?: number
    }

    // Upsert profile
    await adminDb`
      INSERT INTO ai_reply_profiles (
        client_id, persona, tone, system_prompt,
        permitted_topics, prohibited_topics, escalation_triggers,
        max_tokens, temperature
      ) VALUES (
        ${clientId},
        ${b.persona ?? 'a helpful business assistant'},
        ${b.tone ?? 'friendly and professional'},
        ${b.systemPrompt ?? ''},
        ${b.permittedTopics ?? []},
        ${b.prohibitedTopics ?? []},
        ${b.escalationTriggers ?? []},
        ${b.maxTokens ?? 500},
        ${b.temperature ?? 0.7}
      )
      ON CONFLICT (client_id) DO UPDATE SET
        persona             = EXCLUDED.persona,
        tone                = EXCLUDED.tone,
        system_prompt       = EXCLUDED.system_prompt,
        permitted_topics    = EXCLUDED.permitted_topics,
        prohibited_topics   = EXCLUDED.prohibited_topics,
        escalation_triggers = EXCLUDED.escalation_triggers,
        max_tokens          = EXCLUDED.max_tokens,
        temperature         = EXCLUDED.temperature,
        updated_at          = NOW()
    `

    // Update ai_reply toggle in module_config
    if (b.aiReply !== undefined) {
      await adminDb`
        INSERT INTO module_config (client_id, ai_reply)
        VALUES (${clientId}, ${b.aiReply})
        ON CONFLICT (client_id) DO UPDATE SET ai_reply = ${b.aiReply}, updated_at = NOW()
      `
      // When AI reply is enabled, update all active conversations for this client
      if (b.aiReply) {
        await adminDb`
          UPDATE conversations SET ai_active = TRUE
          WHERE client_id = ${clientId} AND status = 'active'
        `
      } else {
        await adminDb`
          UPDATE conversations SET ai_active = FALSE
          WHERE client_id = ${clientId}
        `
      }
    }

    return reply.status(204).send()
  })

  // ── MODERATION RULES ─────────────────────────────────────────

  app.get('/moderation/rules', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    type RRow = { id: string; keyword: string; action: string; severity: string; created_at: string }
    const rows = (await adminDb`SELECT id, keyword, action, severity, created_at FROM moderation_rules ORDER BY created_at DESC`) as unknown as RRow[]
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, action: r.action, severity: r.severity, createdAt: r.created_at })))
  })

  app.post('/moderation/rules', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { keyword, action, severity } = req.body as { keyword?: string; action?: string; severity?: string }
    if (!keyword?.trim()) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'keyword is required' })
    type RIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO moderation_rules (keyword, action, severity)
      VALUES (${keyword.trim().toLowerCase()}, ${action ?? 'flag'}, ${severity ?? 'warning'})
      ON CONFLICT (keyword) DO UPDATE SET action = EXCLUDED.action, severity = EXCLUDED.severity
      RETURNING id, created_at
    `) as unknown as RIRow[]
    return reply.status(201).send({ id: rows[0]!.id, keyword: keyword.trim().toLowerCase(), action: action ?? 'flag', severity: severity ?? 'warning', createdAt: rows[0]!.created_at })
  })

  app.delete('/moderation/rules/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM moderation_rules WHERE id = ${id}`
    return reply.status(204).send()
  })

  app.get('/moderation/events', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    type MRow = { id: string; client_id: string; client_name: string; matched_keyword: string; action_taken: string; content: string; resolved: boolean; created_at: string }
    const rows = (await adminDb`
      SELECT me.*, c.name AS client_name
      FROM   moderation_events me
      JOIN   clients c ON c.id = me.client_id
      WHERE  me.resolved = FALSE
      ORDER BY me.created_at DESC LIMIT 100
    `) as unknown as MRow[]
    return reply.send(rows.map(r => ({
      id: r.id, clientId: r.client_id, clientName: r.client_name,
      matchedKeyword: r.matched_keyword, actionTaken: r.action_taken,
      content: r.content, resolved: r.resolved, createdAt: r.created_at,
    })))
  })

  app.post('/moderation/events/:id/resolve', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`UPDATE moderation_events SET resolved = TRUE, resolved_by = 'operator', resolved_at = NOW() WHERE id = ${id}`
    return reply.status(204).send()
  })

  // ── SUBSCRIPTIONS ─────────────────────────────────────────────

  app.get('/subscriptions', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.query as { clientId?: string }
    type SRow = {
      id: string; client_id: string; client_name: string; plan_name: string
      status: string; trial_ends_at: string | null
      current_period_start: string | null; current_period_end: string | null
      amount: number | null; currency: string; created_at: string
    }
    const rows = clientId
      ? (await adminDb`
          SELECT s.*, c.name AS client_name, p.display_name AS plan_name
          FROM subscriptions s JOIN clients c ON c.id = s.client_id JOIN plans p ON p.id = s.plan_id
          WHERE s.client_id = ${clientId} ORDER BY s.created_at DESC
        `) as unknown as SRow[]
      : (await adminDb`
          SELECT s.*, c.name AS client_name, p.display_name AS plan_name
          FROM subscriptions s JOIN clients c ON c.id = s.client_id JOIN plans p ON p.id = s.plan_id
          ORDER BY s.created_at DESC LIMIT 200
        `) as unknown as SRow[]
    return reply.send(rows.map(r => ({
      id: r.id, clientId: r.client_id, clientName: r.client_name, planName: r.plan_name,
      status: r.status, trialEndsAt: r.trial_ends_at, amount: r.amount, currency: r.currency,
      currentPeriodStart: r.current_period_start, currentPeriodEnd: r.current_period_end,
      createdAt: r.created_at,
    })))
  })

  app.patch('/subscriptions/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    const b = req.body as { status?: string; trialEndsAt?: string }
    await adminDb`
      UPDATE subscriptions SET
        status        = COALESCE(${b.status ?? null}, status),
        trial_ends_at = COALESCE(${b.trialEndsAt ?? null}::TIMESTAMPTZ, trial_ends_at),
        updated_at    = NOW()
      WHERE id = ${id}
    `
    return reply.status(204).send()
  })

  app.get('/revenue', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    type RevRow = { status: string; count: string; total_amount: string }
    const rows = (await adminDb`
      SELECT status, COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS total_amount
      FROM subscriptions GROUP BY status
    `) as unknown as RevRow[]
    type PlanRow = { plan_name: string; count: string }
    const planRows = (await adminDb`
      SELECT p.display_name AS plan_name, COUNT(*)::text AS count
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active','trial')
      GROUP BY p.display_name ORDER BY count DESC
    `) as unknown as PlanRow[]

    const byStatus: Record<string, { count: number; amount: number }> = {}
    for (const r of rows) {
      byStatus[r.status] = { count: parseInt(r.count, 10), amount: parseFloat(r.total_amount) }
    }
    const active = byStatus['active'] ?? { count: 0, amount: 0 }
    const trial  = byStatus['trial']  ?? { count: 0, amount: 0 }

    return reply.send({
      mrr: active.amount,
      activeSubscriptions: active.count,
      trialSubscriptions:  trial.count,
      byStatus,
      byPlan: planRows.map(p => ({ planName: p.plan_name, count: parseInt(p.count, 10) })),
    })
  })

  // ── CLIENT MODERATION ACTIONS ─────────────────────────────────

  app.post('/clients/:clientId/warn', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.params as { clientId: string }
    const { reason } = req.body as { reason?: string }
    await adminDb`UPDATE clients SET warning_count = warning_count + 1, updated_at = NOW() WHERE id = ${clientId}`
    await adminDb`
      INSERT INTO moderation_events (client_id, matched_keyword, action_taken, content)
      VALUES (${clientId}, 'manual', 'warn', ${reason ?? 'Manual warning by operator'})
    `
    return reply.status(204).send()
  })

  app.post('/clients/:clientId/suspend', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.params as { clientId: string }
    const { reason } = req.body as { reason?: string }
    await adminDb`
      UPDATE clients SET status = 'suspended', suspended_at = NOW(),
        suspension_reason = ${reason ?? 'Manual suspension by operator'}, updated_at = NOW()
      WHERE id = ${clientId}
    `
    return reply.status(204).send()
  })

  app.post('/clients/:clientId/unsuspend', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.params as { clientId: string }
    await adminDb`
      UPDATE clients SET status = 'active', suspended_at = NULL,
        suspension_reason = NULL, warning_count = 0, updated_at = NOW()
      WHERE id = ${clientId}
    `
    return reply.status(204).send()
  })

  // ── OPT-OUT MANAGEMENT ────────────────────────────────────────

  app.get('/optouts', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { clientId } = req.query as { clientId?: string }
    type ORow = {
      id: string; client_id: string; phone_number: string
      opted_out: boolean; opted_out_at: string | null; opted_in_at: string | null; updated_at: string
    }
    const rows = clientId
      ? (await adminDb`SELECT * FROM optout_registry WHERE client_id = ${clientId} AND opted_out = TRUE ORDER BY updated_at DESC`) as unknown as ORow[]
      : (await adminDb`SELECT * FROM optout_registry WHERE opted_out = TRUE ORDER BY updated_at DESC LIMIT 200`) as unknown as ORow[]
    return reply.send(rows.map(r => ({
      id: r.id, clientId: r.client_id, phoneNumber: r.phone_number,
      optedOut: r.opted_out, optedOutAt: r.opted_out_at, optedInAt: r.opted_in_at, updatedAt: r.updated_at,
    })))
  })

  // ── MESSAGE TEMPLATES (GLOBAL LIBRARY) ───────────────────────

  app.get('/message-templates', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    type TRow = {
      id: string; name: string; category: string
      content: string; variables: string[]; is_global: boolean; created_at: string
    }
    const rows = (await adminDb`
      SELECT id, name, category, content, variables, is_global, created_at
      FROM message_templates WHERE is_global = TRUE OR client_id IS NULL
      ORDER BY category, name
    `) as unknown as TRow[]
    return reply.send(rows.map(r => ({
      id: r.id, name: r.name, category: r.category,
      content: r.content, variables: r.variables, isGlobal: r.is_global, createdAt: r.created_at,
    })))
  })

  app.post('/message-templates', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const b = req.body as { name?: string; category?: string; content?: string; variables?: string[] }
    if (!b.name?.trim() || !b.content?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name and content required' })
    }
    type TIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO message_templates (name, category, content, variables, is_global)
      VALUES (${b.name.trim()}, ${b.category ?? 'general'}, ${b.content.trim()}, ${b.variables ?? []}, TRUE)
      RETURNING id, created_at
    `) as unknown as TIRow[]
    return reply.status(201).send({
      id: rows[0]!.id, name: b.name.trim(), category: b.category ?? 'general',
      content: b.content.trim(), variables: b.variables ?? [], isGlobal: true, createdAt: rows[0]!.created_at,
    })
  })

  app.delete('/message-templates/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM message_templates WHERE id = ${id} AND is_global = TRUE`
    return reply.status(204).send()
  })

  // ── FLUTTERWAVE WEBHOOK (public — no operator auth) ───────────

  app.post('/flw-webhook', {
    config: { skipAuth: true },
  }, async (req, reply) => {
    const secretHash = process.env['FLW_SECRET_HASH'] ?? ''
    const sig = req.headers['verif-hash'] as string | undefined
    if (!sig || sig !== secretHash) {
      return reply.status(401).send({ error: 'INVALID_SIGNATURE' })
    }

    const body = req.body as {
      event?: string
      data?: {
        id?: number; tx_ref?: string; status?: string; amount?: number; currency?: string
        customer?: { id?: number; email?: string; phone_number?: string }
      }
    }

    if (body.event === 'charge.completed' && body.data?.status === 'successful') {
      const txRef = body.data.tx_ref ?? ''
      // tx_ref format: sub_{clientId}_{timestamp}
      const match = txRef.match(/^sub_([a-f0-9-]+)_/)
      if (match?.[1]) {
        const clientId = match[1]
        await adminDb`
          UPDATE subscriptions SET
            status = 'active',
            flw_tx_id = ${String(body.data.id ?? '')},
            flw_customer_id = ${String(body.data.customer?.id ?? '')},
            amount = ${body.data.amount ?? null},
            currency = ${body.data.currency ?? 'NGN'},
            current_period_start = NOW(),
            current_period_end   = NOW() + INTERVAL '30 days',
            next_payment_at      = NOW() + INTERVAL '30 days',
            updated_at           = NOW()
          WHERE client_id = ${clientId}
        `
        await adminDb`UPDATE clients SET status = 'active', updated_at = NOW() WHERE id = ${clientId}`
      }
    }

    return reply.status(200).send({ received: true })
  })

  // ── Sub-plugins ─────────────────────────────────────────────
  // requests.ts      → /requests, /requests/:id/approve, /requests/:id/reject
  //                    /ai-templates, /ai-templates/:id
  // observability.ts → /events, /audit, /usage, /usage/:businessId, /investigate

  await app.register(requestsRoutes)
  await app.register(observabilityRoutes)
}

export default adminRoutes
