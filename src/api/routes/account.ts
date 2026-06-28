import { randomBytes, createHash } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { adminDb } from '../../db/client.js'
import { currentLimit } from '../../db/redis.js'
import { auditLog } from '../../services/audit.js'
import { logEvent } from '../../services/events.js'

const accountRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /v1/me ────────────────────────────────────────────────
  // Returns the authenticated developer's account info, plan limits,
  // current usage counters, and active session count.

  app.get('/', async (req) => {
    type AccountRow = {
      client_name:         string
      plan_name:           string
      plan_display:        string
      monthly_message_cap: number | null
      daily_message_cap:   number | null
      hourly_message_cap:  number | null
      ai_enabled:          boolean
      voice_enabled:       boolean
      analytics_enabled:   boolean
      max_sessions:        number | null
      client_status:       string
    }

    const rows = (await adminDb`
      SELECT c.name  AS client_name,
             p.name  AS plan_name,
             p.display_name       AS plan_display,
             p.monthly_message_cap,
             p.daily_message_cap,
             p.hourly_message_cap,
             p.ai_enabled,
             p.voice_enabled,
             p.analytics_enabled,
             p.max_sessions,
             c.status             AS client_status
      FROM   clients c
      JOIN   plans   p ON p.id = c.plan_id
      WHERE  c.id = ${req.clientId}
    `) as unknown as AccountRow[]

    const account = rows[0]

    type SessRow = { total: string }
    const sessRows = (await adminDb`
      SELECT COUNT(*)::text AS total
      FROM   whatsapp_sessions
      WHERE  client_id = ${req.clientId} AND status = 'active'
    `) as unknown as SessRow[]

    const sessionsActive = parseInt(sessRows[0]?.total ?? '0', 10)

    const [usedMonthly, usedDaily, usedHourly] = await Promise.all([
      currentLimit(req.clientId, 'monthly'),
      currentLimit(req.clientId, 'daily'),
      currentLimit(req.clientId, 'hourly'),
    ])

    return {
      clientId: req.clientId,
      name:     account?.client_name ?? null,
      status:   account?.client_status ?? 'unknown',
      scopes:   req.scopes,
      plan: account
        ? {
            name:               account.plan_name,
            displayName:        account.plan_display,
            monthlyMessageCap:  account.monthly_message_cap,
            dailyMessageCap:    account.daily_message_cap,
            hourlyMessageCap:   account.hourly_message_cap,
            aiEnabled:          account.ai_enabled,
            voiceEnabled:       account.voice_enabled,
            analyticsEnabled:   account.analytics_enabled,
            maxSessions:        account.max_sessions,
          }
        : null,
      usage: {
        messagesThisMonth: usedMonthly,
        messagesThisDay:   usedDaily,
        messagesThisHour:  usedHourly,
        sessionsActive,
      },
    }
  })
  // ── GET /v1/me/keys — list API keys ────────────────────────────

  app.get('/keys', async (req) => {
    type KeyRow = { id: string; label: string; key_prefix: string; scopes: string[]; environment: string; status: string; last_used_at: string | null; expires_at: string | null; created_at: string }
    const rows = (await adminDb`
      SELECT id, label, key_prefix, scopes, environment, status, last_used_at, expires_at, created_at
      FROM api_keys WHERE client_id = ${req.clientId} AND status != 'revoked'
      ORDER BY created_at DESC
    `) as unknown as KeyRow[]
    return rows.map(k => ({
      id: k.id, label: k.label, prefix: k.key_prefix,
      scopes: k.scopes, environment: k.environment, status: k.status,
      lastUsedAt: k.last_used_at, expiresAt: k.expires_at, createdAt: k.created_at,
    }))
  })

  // ── POST /v1/me/keys — generate a new API key ───────────────────

  app.post('/keys', async (req, reply) => {
    const body = req.body as { label?: string; environment?: 'live' | 'test' }

    const rawKey  = `era_${randomBytes(24).toString('hex')}`
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const prefix  = rawKey.slice(0, 12)
    const label   = body.label?.trim() ?? ''
    const environment: 'live' | 'test' = body.environment === 'test' ? 'test' : 'live'

    // New self-generated keys inherit the same scopes as the current key
    const scopes = req.scopes.filter(s => s !== 'admin')
    if (scopes.length === 0) scopes.push('messaging')

    type KIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO api_keys (client_id, key_hash, key_prefix, label, environment, scopes)
      VALUES (${req.clientId}, ${keyHash}, ${prefix}, ${label}, ${environment}, ${scopes})
      RETURNING id, created_at
    `) as unknown as KIRow[]

    auditLog({ actor: req.clientId, actorLabel: 'Developer', action: 'api_key.created', target: 'api_key', targetId: rows[0]!.id, detail: `Self-generated API key "${label || environment}"` }).catch(() => {})
    logEvent({ eventType: 'api_key_generated', severity: 'info', detail: `API key "${label || environment}" self-generated by developer`, clientId: req.clientId }).catch(() => {})

    return reply.status(201).send({
      id:        rows[0]!.id,
      key:       rawKey,
      prefix,
      label,
      scopes,
      environment,
      createdAt: rows[0]!.created_at,
    })
  })

  // ── DELETE /v1/me/keys/:id — revoke a key ───────────────────────

  app.delete('/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    // Cannot revoke the key currently being used (would lock themselves out)
    if (id === req.apiKeyId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Cannot revoke the key you are currently using' })
    }

    await adminDb`
      UPDATE api_keys SET status = 'revoked', updated_at = NOW()
      WHERE id = ${id} AND client_id = ${req.clientId}
    `
    auditLog({ actor: req.clientId, actorLabel: 'Developer', action: 'api_key.revoked', target: 'api_key', targetId: id, detail: 'API key revoked by developer' }).catch(() => {})

    return reply.status(204).send()
  })
}

export default accountRoutes
