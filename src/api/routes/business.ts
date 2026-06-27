import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto'
import { promisify } from 'node:util'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'

const scryptAsync = promisify(scrypt)

// ── JWT helpers (HMAC-SHA256, no external dep) ──────────────────

const JWT_SECRET = config.operatorSecret + ':biz_portal'

function b64url(s: string) {
  return Buffer.from(s).toString('base64url')
}

function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body   = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 7 }))
  const sig    = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

function verifyJwt(token: string): { clientId: string; userId: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, sig] = parts as [string, string, string]
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
    const sigBuf = Buffer.from(sig, 'base64url')
    const expBuf = Buffer.from(expected, 'base64url')
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
    const pl = JSON.parse(Buffer.from(body, 'base64url').toString()) as { clientId: string; userId: string; exp: number }
    if (pl.exp < Math.floor(Date.now() / 1000)) return null
    return { clientId: pl.clientId, userId: pl.userId }
  } catch { return null }
}

async function hashPassword(pwd: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = (await scryptAsync(pwd, salt, 32)) as Buffer
  return `${salt}:${hash.toString('hex')}`
}

async function verifyPassword(pwd: string, stored: string): Promise<boolean> {
  const idx = stored.indexOf(':')
  if (idx === -1) return false
  const salt = stored.slice(0, idx)
  const hash = stored.slice(idx + 1)
  const hashBuf = Buffer.from(hash, 'hex')
  const derived  = (await scryptAsync(pwd, salt, 32)) as Buffer
  return derived.length === hashBuf.length && timingSafeEqual(derived, hashBuf)
}

// ── Auth guard ──────────────────────────────────────────────────

function getBizAuth(req: FastifyRequest, reply: FastifyReply): { clientId: string; userId: string } | null {
  const auth = req.headers['authorization']
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' })
    return null
  }
  const payload = verifyJwt(auth.slice(7))
  if (!payload) {
    void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Session expired. Please sign in again.' })
    return null
  }
  return payload
}

// ── Ensure config rows exist (called lazily per client) ──────────

async function ensureClientConfig(clientId: string) {
  await Promise.all([
    adminDb`INSERT INTO module_config (client_id) VALUES (${clientId}) ON CONFLICT DO NOTHING`,
    adminDb`INSERT INTO business_hours_config (client_id) VALUES (${clientId}) ON CONFLICT DO NOTHING`,
    adminDb`INSERT INTO auto_greet_config (client_id) VALUES (${clientId}) ON CONFLICT DO NOTHING`,
    adminDb`INSERT INTO handoff_config (client_id) VALUES (${clientId}) ON CONFLICT DO NOTHING`,
    adminDb`INSERT INTO voice_config (client_id) VALUES (${clientId}) ON CONFLICT DO NOTHING`,
  ])
}

function mapModuleConfig(mod: {
  knowledge_base: boolean; auto_greet: boolean; business_hours: boolean
  scenarios: boolean; human_handoff: boolean; voice_notes: boolean
  conversation_inbox: boolean; analytics: boolean; email_campaigns: boolean
  automations: boolean
}) {
  return {
    knowledgeBase:     mod.knowledge_base,
    autoGreet:         mod.auto_greet,
    businessHours:     mod.business_hours,
    scenarios:         mod.scenarios,
    humanHandoff:      mod.human_handoff,
    voiceNotes:        mod.voice_notes,
    conversationInbox: mod.conversation_inbox,
    analytics:         mod.analytics,
    emailCampaigns:    mod.email_campaigns,
    automations:       mod.automations,
  }
}

// ── Plugin ──────────────────────────────────────────────────────

const businessRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /auth/login ──────────────────────────────────────────

  app.post('/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string }
    if (!body.email || !body.password) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'email and password are required' })
    }

    type UserRow = {
      id: string; client_id: string; password_hash: string
      client_name: string; client_slug: string | null
      contact_email: string | null; contact_phone: string | null
      plan_name: string; plan_display: string
      status: string; monthly_message_cap: number | null
    }

    const users = (await adminDb`
      SELECT bu.id, bu.client_id, bu.password_hash,
             c.name AS client_name, c.slug AS client_slug,
             c.contact_email, c.contact_phone,
             p.name AS plan_name, p.display_name AS plan_display,
             c.status, p.monthly_message_cap
      FROM   business_users bu
      JOIN   clients c ON c.id = bu.client_id
      JOIN   plans   p ON p.id = c.plan_id
      WHERE  bu.email = ${body.email.toLowerCase().trim()}
    `) as unknown as UserRow[]

    const user = users[0]
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      return reply.status(401).send({ error: 'INVALID_CREDENTIALS', message: 'Incorrect email or password' })
    }
    if (user.status !== 'active') {
      return reply.status(403).send({ error: 'ACCOUNT_SUSPENDED', message: 'This account has been suspended. Contact support.' })
    }

    await adminDb`UPDATE business_users SET last_login_at = NOW() WHERE id = ${user.id}`
    await ensureClientConfig(user.client_id)

    const token = signJwt({ clientId: user.client_id, userId: user.id })

    type ModRow = {
      knowledge_base: boolean; auto_greet: boolean; business_hours: boolean
      scenarios: boolean; human_handoff: boolean; voice_notes: boolean
      conversation_inbox: boolean; analytics: boolean; email_campaigns: boolean; automations: boolean
    }
    const mods = (await adminDb`SELECT * FROM module_config WHERE client_id = ${user.client_id}`) as unknown as ModRow[]
    const mod = mods[0]!

    return reply.send({
      token,
      profile: {
        id:           user.client_id,
        name:         user.client_name,
        slug:         user.client_slug ?? user.client_id.slice(0, 8),
        contactEmail: user.contact_email ?? body.email,
        contactPhone: user.contact_phone,
        planName:     user.plan_display,
        active:       user.status === 'active',
        usage:        { monthlyMessages: 0, sessionsActive: 0, monthlyLimit: user.monthly_message_cap },
        moduleConfig: mapModuleConfig(mod),
      },
    })
  })

  // ── POST /auth/change-password ────────────────────────────────

  app.post('/auth/change-password', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return

    const body = req.body as { currentPassword?: string; newPassword?: string }
    if (!body.currentPassword || !body.newPassword) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'currentPassword and newPassword are required' })
    }
    if (body.newPassword.length < 8) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'New password must be at least 8 characters' })
    }

    type PwRow = { password_hash: string }
    const users = (await adminDb`SELECT password_hash FROM business_users WHERE id = ${auth.userId}`) as unknown as PwRow[]
    if (!users[0] || !(await verifyPassword(body.currentPassword, users[0].password_hash))) {
      return reply.status(401).send({ error: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' })
    }

    const newHash = await hashPassword(body.newPassword)
    await adminDb`UPDATE business_users SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${auth.userId}`
    return reply.status(204).send()
  })

  // ── GET /me ────────────────────────────────────────────────────

  app.get('/me', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)

    type ClientRow = {
      id: string; name: string; slug: string | null
      contact_email: string | null; contact_phone: string | null
      plan_display: string; status: string; monthly_message_cap: number | null
    }
    const clients = (await adminDb`
      SELECT c.id, c.name, c.slug, c.contact_email, c.contact_phone,
             p.display_name AS plan_display, c.status, p.monthly_message_cap
      FROM   clients c JOIN plans p ON p.id = c.plan_id
      WHERE  c.id = ${auth.clientId}
    `) as unknown as ClientRow[]

    const c = clients[0]
    if (!c) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Client not found' })

    type ModRow = {
      knowledge_base: boolean; auto_greet: boolean; business_hours: boolean
      scenarios: boolean; human_handoff: boolean; voice_notes: boolean
      conversation_inbox: boolean; analytics: boolean; email_campaigns: boolean; automations: boolean
    }
    const mods    = (await adminDb`SELECT * FROM module_config WHERE client_id = ${auth.clientId}`) as unknown as ModRow[]
    const mod     = mods[0]!
    type SessRow  = { total: string }
    const sess    = (await adminDb`SELECT COUNT(*)::text AS total FROM whatsapp_sessions WHERE client_id = ${auth.clientId} AND status = 'active'`) as unknown as SessRow[]

    return reply.send({
      id:           c.id,
      name:         c.name,
      slug:         c.slug ?? c.id.slice(0, 8),
      contactEmail: c.contact_email,
      contactPhone: c.contact_phone,
      planName:     c.plan_display,
      active:       c.status === 'active',
      usage:        { monthlyMessages: 0, sessionsActive: parseInt(sess[0]?.total ?? '0', 10), monthlyLimit: c.monthly_message_cap },
      moduleConfig: mapModuleConfig(mod),
    })
  })

  // ── PATCH /me ──────────────────────────────────────────────────

  app.patch('/me', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const body = req.body as { contactEmail?: string; contactPhone?: string }
    if (body.contactEmail) {
      await adminDb`UPDATE clients SET contact_email = ${body.contactEmail}, updated_at = NOW() WHERE id = ${auth.clientId}`
    }
    if (body.contactPhone !== undefined) {
      await adminDb`UPDATE clients SET contact_phone = ${body.contactPhone ?? null}, updated_at = NOW() WHERE id = ${auth.clientId}`
    }
    return reply.status(204).send()
  })

  // ── PATCH /modules ─────────────────────────────────────────────

  app.patch('/modules', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)

    const b = req.body as Partial<{
      knowledgeBase: boolean; autoGreet: boolean; businessHours: boolean
      scenarios: boolean; humanHandoff: boolean; voiceNotes: boolean
      conversationInbox: boolean; analytics: boolean; emailCampaigns: boolean
    }>

    await adminDb`
      UPDATE module_config SET
        knowledge_base     = COALESCE(${b.knowledgeBase    ?? null}, knowledge_base),
        auto_greet         = COALESCE(${b.autoGreet        ?? null}, auto_greet),
        business_hours     = COALESCE(${b.businessHours    ?? null}, business_hours),
        scenarios          = COALESCE(${b.scenarios        ?? null}, scenarios),
        human_handoff      = COALESCE(${b.humanHandoff     ?? null}, human_handoff),
        voice_notes        = COALESCE(${b.voiceNotes       ?? null}, voice_notes),
        conversation_inbox = COALESCE(${b.conversationInbox ?? null}, conversation_inbox),
        analytics          = COALESCE(${b.analytics        ?? null}, analytics),
        email_campaigns    = COALESCE(${b.emailCampaigns   ?? null}, email_campaigns),
        updated_at         = NOW()
      WHERE client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  // ── Knowledge Base ─────────────────────────────────────────────

  app.get('/knowledge-base', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type KBRow = { id: string; section: string; title: string; content: string; updated_at: string }
    const rows = (await adminDb`
      SELECT id, section, title, content, updated_at
      FROM   knowledge_base_entries
      WHERE  client_id = ${auth.clientId}
      ORDER BY section, title
    `) as unknown as KBRow[]
    return reply.send(rows.map(r => ({ id: r.id, section: r.section, title: r.title, content: r.content, updatedAt: r.updated_at })))
  })

  app.post('/knowledge-base', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const body = req.body as { id?: string; section?: string; title?: string; content?: string }
    if (!body.title?.trim() || !body.content?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'title and content are required' })
    }

    if (body.id) {
      await adminDb`
        UPDATE knowledge_base_entries
        SET section = ${body.section ?? 'General'}, title = ${body.title.trim()},
            content = ${body.content.trim()}, updated_at = NOW()
        WHERE id = ${body.id} AND client_id = ${auth.clientId}
      `
      type KBRow2 = { id: string; section: string; title: string; content: string; updated_at: string }
      const rows = (await adminDb`SELECT id, section, title, content, updated_at FROM knowledge_base_entries WHERE id = ${body.id}`) as unknown as KBRow2[]
      const r = rows[0]
      return reply.send(r ? { id: r.id, section: r.section, title: r.title, content: r.content, updatedAt: r.updated_at } : null)
    }

    type KBIRow = { id: string; section: string; title: string; content: string; updated_at: string }
    const rows = (await adminDb`
      INSERT INTO knowledge_base_entries (client_id, section, title, content)
      VALUES (${auth.clientId}, ${body.section ?? 'General'}, ${body.title.trim()}, ${body.content.trim()})
      RETURNING id, section, title, content, updated_at
    `) as unknown as KBIRow[]
    const r = rows[0]!
    return reply.status(201).send({ id: r.id, section: r.section, title: r.title, content: r.content, updatedAt: r.updated_at })
  })

  app.delete('/knowledge-base/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM knowledge_base_entries WHERE id = ${id} AND client_id = ${auth.clientId}`
    return reply.status(204).send()
  })

  // ── Business Hours ─────────────────────────────────────────────

  app.get('/hours', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    type HRow = { hours_json: unknown }
    const rows = (await adminDb`SELECT hours_json FROM business_hours_config WHERE client_id = ${auth.clientId}`) as unknown as HRow[]
    return reply.send(rows[0]?.hours_json ?? {})
  })

  app.patch('/hours', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    const hours = req.body
    await adminDb`UPDATE business_hours_config SET hours_json = ${JSON.stringify(hours)}, updated_at = NOW() WHERE client_id = ${auth.clientId}`
    return reply.send(hours)
  })

  // ── Auto-Greet ─────────────────────────────────────────────────

  app.get('/auto-greet', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    type AGRow = { message: string }
    const rows = (await adminDb`SELECT message FROM auto_greet_config WHERE client_id = ${auth.clientId}`) as unknown as AGRow[]
    return reply.send({ message: rows[0]?.message ?? '' })
  })

  app.patch('/auto-greet', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    const { message } = req.body as { message?: string }
    if (!message?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'message is required' })
    }
    await adminDb`UPDATE auto_greet_config SET message = ${message.trim()}, updated_at = NOW() WHERE client_id = ${auth.clientId}`
    return reply.send({ message: message.trim() })
  })

  // ── Scenarios ──────────────────────────────────────────────────

  app.get('/scenarios', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type SRow = { id: string; name: string; template_key: string; trigger: string; active: boolean; priority: number; config: Record<string, string>; created_at: string }
    const rows = (await adminDb`
      SELECT id, name, template_key, trigger, active, priority, config, created_at
      FROM   business_scenarios
      WHERE  client_id = ${auth.clientId}
      ORDER BY priority DESC, created_at DESC
    `) as unknown as SRow[]
    return reply.send(rows.map(r => ({ id: r.id, name: r.name, templateKey: r.template_key, trigger: r.trigger, active: r.active, priority: r.priority, config: r.config, createdAt: r.created_at })))
  })

  app.post('/scenarios', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const b = req.body as { name?: string; templateKey?: string; trigger?: string; active?: boolean; priority?: number; config?: Record<string, string> }
    if (!b.name?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name is required' })
    }
    type SIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO business_scenarios (client_id, name, template_key, trigger, active, priority, config)
      VALUES (
        ${auth.clientId}, ${b.name.trim()}, ${b.templateKey ?? 'custom'},
        ${b.trigger ?? ''}, ${b.active ?? true}, ${b.priority ?? 0},
        ${JSON.stringify(b.config ?? {})}
      )
      RETURNING id, created_at
    `) as unknown as SIRow[]
    const row = rows[0]!
    return reply.status(201).send({
      id: row.id, name: b.name.trim(), templateKey: b.templateKey ?? 'custom',
      trigger: b.trigger ?? '', active: b.active ?? true,
      priority: b.priority ?? 0, config: b.config ?? {}, createdAt: row.created_at,
    })
  })

  app.patch('/scenarios/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const b = req.body as { name?: string; templateKey?: string; trigger?: string; active?: boolean; priority?: number; config?: Record<string, string> }
    const configJson = b.config != null ? JSON.stringify(b.config) : null
    await adminDb`
      UPDATE business_scenarios SET
        name         = COALESCE(${b.name        ?? null}, name),
        template_key = COALESCE(${b.templateKey ?? null}, template_key),
        trigger      = COALESCE(${b.trigger     ?? null}, trigger),
        active       = COALESCE(${b.active      ?? null}, active),
        priority     = COALESCE(${b.priority    ?? null}, priority),
        config       = COALESCE(${configJson}::jsonb, config),
        updated_at   = NOW()
      WHERE id = ${id} AND client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  app.delete('/scenarios/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM business_scenarios WHERE id = ${id} AND client_id = ${auth.clientId}`
    return reply.status(204).send()
  })

  // ── Handoff Config ─────────────────────────────────────────────

  app.get('/handoff', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    type HFRow = {
      trigger_on_request: boolean; trigger_on_confusion: boolean; trigger_on_complaint: boolean
      custom_keywords: string; urgent_topics: string; alert_whatsapp: string; alert_email: string
      wait_message: string; max_wait_minutes: number | null; on_no_response: string
    }
    const rows = (await adminDb`SELECT * FROM handoff_config WHERE client_id = ${auth.clientId}`) as unknown as HFRow[]
    if (!rows[0]) return reply.send({})
    const r = rows[0]!
    return reply.send({
      triggerOnRequest:   r.trigger_on_request,
      triggerOnConfusion: r.trigger_on_confusion,
      triggerOnComplaint: r.trigger_on_complaint,
      customKeywords:     r.custom_keywords,
      urgentTopics:       r.urgent_topics,
      alertWhatsApp:      r.alert_whatsapp,
      alertEmail:         r.alert_email,
      waitMessage:        r.wait_message,
      maxWaitMinutes:     r.max_wait_minutes,
      onNoResponse:       r.on_no_response,
    })
  })

  app.patch('/handoff', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    const b = req.body as {
      triggerOnRequest?: boolean; triggerOnConfusion?: boolean; triggerOnComplaint?: boolean
      customKeywords?: string; urgentTopics?: string; alertWhatsApp?: string; alertEmail?: string
      waitMessage?: string; maxWaitMinutes?: number | null; onNoResponse?: string
    }
    await adminDb`
      UPDATE handoff_config SET
        trigger_on_request   = COALESCE(${b.triggerOnRequest   ?? null}, trigger_on_request),
        trigger_on_confusion = COALESCE(${b.triggerOnConfusion ?? null}, trigger_on_confusion),
        trigger_on_complaint = COALESCE(${b.triggerOnComplaint ?? null}, trigger_on_complaint),
        custom_keywords      = COALESCE(${b.customKeywords     ?? null}, custom_keywords),
        urgent_topics        = COALESCE(${b.urgentTopics       ?? null}, urgent_topics),
        alert_whatsapp       = COALESCE(${b.alertWhatsApp      ?? null}, alert_whatsapp),
        alert_email          = COALESCE(${b.alertEmail         ?? null}, alert_email),
        wait_message         = COALESCE(${b.waitMessage        ?? null}, wait_message),
        max_wait_minutes     = COALESCE(${b.maxWaitMinutes     ?? null}, max_wait_minutes),
        on_no_response       = COALESCE(${b.onNoResponse       ?? null}, on_no_response),
        updated_at           = NOW()
      WHERE client_id = ${auth.clientId}
    `
    return reply.send(b)
  })

  // ── Conversations (Inbox) ──────────────────────────────────────

  app.get('/conversations', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type ConvRow = {
      id: string; customer_phone: string; status: string
      last_message: string | null; last_message_at: string | null; unread_count: string
    }
    const rows = (await adminDb`
      SELECT conv.id,
             ct.phone_number AS customer_phone,
             CASE WHEN conv.status = 'escalated' THEN 'human'
                  WHEN conv.status = 'closed'    THEN 'resolved'
                  ELSE 'ai_active' END AS status,
             (SELECT m.content    FROM messages m WHERE m.conversation_id = conv.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT m.created_at FROM messages m WHERE m.conversation_id = conv.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
             '0'::text AS unread_count
      FROM   conversations conv
      JOIN   contacts ct ON ct.id = conv.contact_id
      WHERE  conv.client_id = ${auth.clientId}
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 100
    `) as unknown as ConvRow[]
    return reply.send(rows.map(r => ({
      id:            r.id,
      customerPhone: r.customer_phone,
      status:        r.status,
      lastMessage:   r.last_message ?? '',
      lastMessageAt: r.last_message_at ?? new Date().toISOString(),
      unreadCount:   parseInt(r.unread_count, 10),
    })))
  })

  app.get('/conversations/:id/messages', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    type MsgRow = { id: string; direction: string; content: string; ai_generated: boolean; created_at: string }
    const rows = (await adminDb`
      SELECT id, direction, content, ai_generated, created_at
      FROM   messages
      WHERE  conversation_id = ${id} AND client_id = ${auth.clientId}
      ORDER BY created_at ASC
      LIMIT 200
    `) as unknown as MsgRow[]
    return reply.send(rows.map(m => ({
      id:        m.id,
      role:      m.direction === 'inbound' ? 'customer' : m.ai_generated ? 'ai' : 'human',
      content:   m.content,
      createdAt: m.created_at,
    })))
  })

  app.post('/conversations/:id/take-over', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`
      UPDATE conversations
      SET ai_active = FALSE, status = 'escalated',
          escalated_at = NOW(), escalation_reason = 'manual_human_takeover'
      WHERE id = ${id} AND client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  app.post('/conversations/:id/hand-back', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`
      UPDATE conversations
      SET ai_active = TRUE, status = 'active', resumed_at = NOW()
      WHERE id = ${id} AND client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  app.post('/conversations/:id/messages', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const { content } = req.body as { content?: string }
    if (!content?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'content is required' })
    }

    type SessRow = { id: string }
    const sessions = (await adminDb`
      SELECT id FROM whatsapp_sessions WHERE client_id = ${auth.clientId} AND status = 'active' LIMIT 1
    `) as unknown as SessRow[]
    if (!sessions[0]) {
      return reply.status(400).send({ error: 'NO_SESSION', message: 'No active WhatsApp session to send from' })
    }
    const sessionId = sessions[0].id

    type ConvRow2 = { profile_version_id: string }
    const convs = (await adminDb`
      SELECT profile_version_id FROM conversations WHERE id = ${id} AND client_id = ${auth.clientId}
    `) as unknown as ConvRow2[]
    if (!convs[0]) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Conversation not found' })
    }

    const idempotencyKey = `human_${Date.now()}_${Math.random().toString(36).slice(2)}`
    type MsgRow2 = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO messages
        (conversation_id, client_id, session_id, direction, content, idempotency_key, ai_generated, ai_bypassed)
      VALUES
        (${id}, ${auth.clientId}, ${sessionId}, 'outbound', ${content.trim()}, ${idempotencyKey}, FALSE, TRUE)
      RETURNING id, created_at
    `) as unknown as MsgRow2[]

    return reply.status(201).send({ id: rows[0]!.id, role: 'human', content: content.trim(), createdAt: rows[0]!.created_at })
  })

  // ── Voice ──────────────────────────────────────────────────────

  app.get('/voice-status', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type TRow = { total: string }
    const rows = (await adminDb`
      SELECT COUNT(*)::text AS total FROM voice_calls
      WHERE client_id = ${auth.clientId} AND initiated_at >= NOW() - INTERVAL '24 hours'
    `) as unknown as TRow[]
    return reply.send({ available: true, transcriptionsToday: parseInt(rows[0]?.total ?? '0', 10) })
  })

  app.get('/voice-config', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    type VCRow = { response_mode: string; response_voice: string; show_transcription: boolean; language_hint: string }
    const rows = (await adminDb`
      SELECT response_mode, response_voice, show_transcription, language_hint
      FROM   voice_config WHERE client_id = ${auth.clientId}
    `) as unknown as VCRow[]
    if (!rows[0]) return reply.send({ responseMode: 'text', responseVoice: 'natural', showTranscription: true, languageHint: 'en' })
    const r = rows[0]!
    return reply.send({ responseMode: r.response_mode, responseVoice: r.response_voice, showTranscription: r.show_transcription, languageHint: r.language_hint })
  })

  app.patch('/voice-config', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    await ensureClientConfig(auth.clientId)
    const b = req.body as { responseMode?: string; responseVoice?: string; showTranscription?: boolean; languageHint?: string }
    await adminDb`
      UPDATE voice_config SET
        response_mode      = COALESCE(${b.responseMode      ?? null}, response_mode),
        response_voice     = COALESCE(${b.responseVoice     ?? null}, response_voice),
        show_transcription = COALESCE(${b.showTranscription ?? null}, show_transcription),
        language_hint      = COALESCE(${b.languageHint      ?? null}, language_hint),
        updated_at         = NOW()
      WHERE client_id = ${auth.clientId}
    `
    return reply.send(b)
  })

  // ── Analytics ──────────────────────────────────────────────────

  app.get('/analytics', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { period } = req.query as { period?: string }
    const now = new Date()
    let startOfMonth: Date, endOfMonth: Date
    if (period === 'today') {
      startOfMonth = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
      endOfMonth   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
    } else if (period === 'this_week') {
      const day = now.getDay()
      const monday = new Date(now); monday.setDate(now.getDate() - ((day + 6) % 7)); monday.setHours(0, 0, 0, 0)
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23, 59, 59, 0)
      startOfMonth = monday; endOfMonth = sunday
    } else if (period === 'last_month') {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      startOfMonth = d
      endOfMonth   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)
    } else if (period && /^\d{4}-\d{2}$/.test(period)) {
      const parts = period.split('-')
      const yr = parseInt(parts[0]!, 10)
      const mo = parseInt(parts[1]!, 10)
      startOfMonth = new Date(yr, mo - 1, 1)
      endOfMonth   = new Date(yr, mo, 0, 23, 59, 59)
    } else {
      startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    }

    type MsgStats = { total: string; ai_count: string; handoff_count: string }
    const stats = (await adminDb`
      SELECT COUNT(*)::text AS total,
             SUM(CASE WHEN ai_generated  THEN 1 ELSE 0 END)::text AS ai_count,
             SUM(CASE WHEN ai_bypassed   THEN 1 ELSE 0 END)::text AS handoff_count
      FROM   messages
      WHERE  client_id = ${auth.clientId}
        AND  created_at >= ${startOfMonth}
        AND  created_at <= ${endOfMonth}
    `) as unknown as MsgStats[]
    const ms = stats[0]!

    return reply.send({
      totalMessages:      parseInt(ms.total        ?? '0', 10),
      aiHandled:          parseInt(ms.ai_count      ?? '0', 10),
      humanHandoffs:      parseInt(ms.handoff_count ?? '0', 10),
      avgResponseSeconds: 3,
      voiceNotesCount:    0,
      topScenario:        null,
      messagesByHour:     Array.from({ length: 24 }, () => 0),
      topQuestions:       [],
      handoffReasons:     [],
      usage:              { used: parseInt(ms.total ?? '0', 10), limit: null },
    })
  })

  // ── Notifications ──────────────────────────────────────────────

  app.get('/notifications', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type NRow = { whatsapp_handoff_alerts: boolean; email_daily_digest: boolean }
    const rows = (await adminDb`
      SELECT whatsapp_handoff_alerts, email_daily_digest
      FROM   notification_prefs WHERE business_user_id = ${auth.userId}
    `) as unknown as NRow[]
    if (!rows[0]) {
      await adminDb`INSERT INTO notification_prefs (business_user_id) VALUES (${auth.userId}) ON CONFLICT DO NOTHING`
      return reply.send({ whatsappHandoffAlerts: true, emailDailyDigest: false })
    }
    return reply.send({ whatsappHandoffAlerts: rows[0]!.whatsapp_handoff_alerts, emailDailyDigest: rows[0]!.email_daily_digest })
  })

  app.patch('/notifications', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const b = req.body as { whatsappHandoffAlerts?: boolean; emailDailyDigest?: boolean }
    await adminDb`
      INSERT INTO notification_prefs (business_user_id, whatsapp_handoff_alerts, email_daily_digest)
      VALUES (${auth.userId}, ${b.whatsappHandoffAlerts ?? true}, ${b.emailDailyDigest ?? false})
      ON CONFLICT (business_user_id) DO UPDATE SET
        whatsapp_handoff_alerts = COALESCE(${b.whatsappHandoffAlerts ?? null}, notification_prefs.whatsapp_handoff_alerts),
        email_daily_digest      = COALESCE(${b.emailDailyDigest      ?? null}, notification_prefs.email_daily_digest),
        updated_at              = NOW()
    `
    return reply.send({ whatsappHandoffAlerts: b.whatsappHandoffAlerts ?? true, emailDailyDigest: b.emailDailyDigest ?? false })
  })

  // ── Email: Domains (read-only — managed by operator) ──────────

  app.get('/email/domains', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type DRow = { id: string; domain: string; spf_verified: boolean; dkim_verified: boolean; dmarc_verified: boolean }
    const rows = (await adminDb`
      SELECT id, domain, spf_verified, dkim_verified, dmarc_verified
      FROM   email_domains WHERE client_id = ${auth.clientId}
      ORDER BY created_at DESC
    `) as unknown as DRow[]
    return reply.send(rows.map(r => ({
      id: r.id, domain: r.domain,
      verified: r.spf_verified && r.dkim_verified && r.dmarc_verified,
    })))
  })

  // ── Email: Templates ───────────────────────────────────────────

  app.get('/email/templates', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type TRow = { id: string; name: string; subject: string; html_body: string; updated_at: string }
    const rows = (await adminDb`
      SELECT id, name, subject, html_body, updated_at
      FROM   email_templates WHERE client_id = ${auth.clientId}
      ORDER BY updated_at DESC
    `) as unknown as TRow[]
    return reply.send(rows.map(r => ({ id: r.id, name: r.name, subject: r.subject, htmlBody: r.html_body, updatedAt: r.updated_at })))
  })

  app.post('/email/templates', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { name, subject, htmlBody } = req.body as { name?: string; subject?: string; htmlBody?: string }
    if (!name?.trim() || !subject?.trim() || !htmlBody?.trim())
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name, subject, and htmlBody are required' })
    type TIRow = { id: string; updated_at: string }
    const rows = (await adminDb`
      INSERT INTO email_templates (client_id, name, subject, html_body)
      VALUES (${auth.clientId}, ${name.trim()}, ${subject.trim()}, ${htmlBody.trim()})
      RETURNING id, updated_at
    `) as unknown as TIRow[]
    const r = rows[0]!
    return reply.status(201).send({ id: r.id, name: name.trim(), subject: subject.trim(), htmlBody: htmlBody.trim(), updatedAt: r.updated_at })
  })

  app.put('/email/templates/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const { name, subject, htmlBody } = req.body as { name?: string; subject?: string; htmlBody?: string }
    await adminDb`
      UPDATE email_templates SET
        name       = COALESCE(${name      ?? null}, name),
        subject    = COALESCE(${subject   ?? null}, subject),
        html_body  = COALESCE(${htmlBody  ?? null}, html_body),
        updated_at = NOW()
      WHERE id = ${id} AND client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  app.delete('/email/templates/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM email_templates WHERE id = ${id} AND client_id = ${auth.clientId}`
    return reply.status(204).send()
  })

  // ── Email: Contact Lists ───────────────────────────────────────

  app.get('/email/contacts/lists', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type LRow = { id: string; name: string; created_at: string; contact_count: string }
    const rows = (await adminDb`
      SELECT l.id, l.name, l.created_at, COUNT(ec.id)::text AS contact_count
      FROM   email_contact_lists l
      LEFT JOIN email_contacts ec ON ec.list_id = l.id
      WHERE  l.client_id = ${auth.clientId}
      GROUP BY l.id ORDER BY l.created_at DESC
    `) as unknown as LRow[]
    return reply.send(rows.map(r => ({ id: r.id, name: r.name, contactCount: parseInt(r.contact_count, 10), createdAt: r.created_at })))
  })

  app.post('/email/contacts/lists', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { name } = req.body as { name?: string }
    if (!name?.trim()) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name is required' })
    type LIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO email_contact_lists (client_id, name) VALUES (${auth.clientId}, ${name.trim()})
      RETURNING id, created_at
    `) as unknown as LIRow[]
    const r = rows[0]!
    return reply.status(201).send({ id: r.id, name: name.trim(), contactCount: 0, createdAt: r.created_at })
  })

  app.delete('/email/contacts/lists/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM email_contact_lists WHERE id = ${id} AND client_id = ${auth.clientId}`
    return reply.status(204).send()
  })

  app.get('/email/contacts/lists/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    type CRow = { id: string; email: string; first_name: string | null; last_name: string | null; created_at: string }
    const rows = (await adminDb`
      SELECT id, email, first_name, last_name, created_at
      FROM   email_contacts WHERE list_id = ${id} AND client_id = ${auth.clientId}
      ORDER BY created_at DESC LIMIT 500
    `) as unknown as CRow[]
    return reply.send(rows.map(r => ({ id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, createdAt: r.created_at })))
  })

  app.post('/email/contacts/lists/:id/import', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const list = (await adminDb`SELECT id FROM email_contact_lists WHERE id = ${id} AND client_id = ${auth.clientId}`) as unknown as { id: string }[]
    if (!list[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'List not found' })
    const contacts = req.body as { email: string; firstName?: string; lastName?: string }[]
    if (!Array.isArray(contacts) || contacts.length === 0)
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Provide array of contacts' })
    let imported = 0
    for (const c of contacts) {
      if (!c.email?.includes('@')) continue
      await adminDb`
        INSERT INTO email_contacts (list_id, client_id, email, first_name, last_name)
        VALUES (${id}, ${auth.clientId}, ${c.email.toLowerCase()}, ${c.firstName ?? null}, ${c.lastName ?? null})
        ON CONFLICT (list_id, email) DO NOTHING
      `
      imported++
    }
    return reply.send({ imported })
  })

  app.delete('/email/contacts/:contactId', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { contactId } = req.params as { contactId: string }
    await adminDb`DELETE FROM email_contacts WHERE id = ${contactId} AND client_id = ${auth.clientId}`
    return reply.status(204).send()
  })

  // ── Email: Campaigns ───────────────────────────────────────────

  app.get('/email/campaigns', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type CampRow = {
      id: string; name: string; status: string
      template_name: string; list_name: string
      total_recipients: number; total_sent: number; total_delivered: number
      total_clicked: number; total_bounced: number
      scheduled_at: string | null; started_at: string | null; completed_at: string | null
      created_at: string
    }
    const rows = (await adminDb`
      SELECT camp.id, camp.name, camp.status, camp.scheduled_at, camp.started_at, camp.completed_at,
             camp.total_recipients, camp.total_sent, camp.total_delivered, camp.total_clicked, camp.total_bounced,
             camp.created_at,
             t.name AS template_name, l.name AS list_name
      FROM   email_campaigns camp
      JOIN   email_templates       t ON t.id = camp.template_id
      JOIN   email_contact_lists   l ON l.id = camp.list_id
      WHERE  camp.client_id = ${auth.clientId}
      ORDER BY camp.created_at DESC LIMIT 100
    `) as unknown as CampRow[]
    return reply.send(rows.map(r => ({
      id: r.id, name: r.name, status: r.status,
      templateName: r.template_name, listName: r.list_name,
      totalRecipients: Number(r.total_recipients), totalSent: Number(r.total_sent),
      totalDelivered: Number(r.total_delivered), totalClicked: Number(r.total_clicked),
      totalBounced: Number(r.total_bounced),
      deliveryRate: r.total_sent ? Math.round((Number(r.total_delivered) / Number(r.total_sent)) * 10000) / 100 : 0,
      scheduledAt: r.scheduled_at, startedAt: r.started_at, completedAt: r.completed_at,
      createdAt: r.created_at,
    })))
  })

  app.post('/email/campaigns', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { name, templateId, listId, domainId, fromName, fromEmail, scheduledAt } = req.body as {
      name?: string; templateId?: string; listId?: string; domainId?: string
      fromName?: string; fromEmail?: string; scheduledAt?: string
    }
    if (!name?.trim() || !templateId || !listId || !domainId || !fromName?.trim() || !fromEmail?.trim())
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name, templateId, listId, domainId, fromName, fromEmail are required' })
    const tmpl = (await adminDb`SELECT id FROM email_templates WHERE id = ${templateId} AND client_id = ${auth.clientId}`) as unknown as { id: string }[]
    if (!tmpl[0]) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Template not found' })
    const lst = (await adminDb`SELECT id FROM email_contact_lists WHERE id = ${listId} AND client_id = ${auth.clientId}`) as unknown as { id: string }[]
    if (!lst[0]) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Contact list not found' })
    const dom = (await adminDb`SELECT id FROM email_domains WHERE id = ${domainId} AND client_id = ${auth.clientId}`) as unknown as { id: string }[]
    if (!dom[0]) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Domain not found' })
    type CIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO email_campaigns (client_id, name, template_id, list_id, domain_id, from_name, from_email, status, scheduled_at)
      VALUES (${auth.clientId}, ${name.trim()}, ${templateId}, ${listId}, ${domainId}, ${fromName.trim()}, ${fromEmail.trim()},
              ${scheduledAt ? 'scheduled' : 'draft'}, ${scheduledAt ?? null})
      RETURNING id, created_at
    `) as unknown as CIRow[]
    const r = rows[0]!
    return reply.status(201).send({ id: r.id, name: name.trim(), status: scheduledAt ? 'scheduled' : 'draft', createdAt: r.created_at })
  })

  app.get('/email/campaigns/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    type CampRow2 = {
      id: string; name: string; status: string; from_name: string; from_email: string
      template_name: string; template_id: string; list_name: string; list_id: string
      total_recipients: number; total_sent: number; total_delivered: number
      total_clicked: number; total_bounced: number
      scheduled_at: string | null; started_at: string | null; completed_at: string | null
      created_at: string
    }
    const rows = (await adminDb`
      SELECT camp.*, t.name AS template_name, l.name AS list_name
      FROM   email_campaigns camp
      JOIN   email_templates       t ON t.id = camp.template_id
      JOIN   email_contact_lists   l ON l.id = camp.list_id
      WHERE  camp.id = ${id} AND camp.client_id = ${auth.clientId}
    `) as unknown as CampRow2[]
    if (!rows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Campaign not found' })
    const r = rows[0]!
    return reply.send({
      id: r.id, name: r.name, status: r.status,
      fromName: r.from_name, fromEmail: r.from_email,
      templateId: r.template_id, templateName: r.template_name,
      listId: r.list_id, listName: r.list_name,
      totalRecipients: Number(r.total_recipients), totalSent: Number(r.total_sent),
      totalDelivered: Number(r.total_delivered), totalClicked: Number(r.total_clicked),
      totalBounced: Number(r.total_bounced),
      scheduledAt: r.scheduled_at, startedAt: r.started_at, completedAt: r.completed_at,
      createdAt: r.created_at,
    })
  })

  app.post('/email/campaigns/:id/send', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const camp = (await adminDb`SELECT status FROM email_campaigns WHERE id = ${id} AND client_id = ${auth.clientId}`) as unknown as { status: string }[]
    if (!camp[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Campaign not found' })
    if (camp[0].status === 'sending' || camp[0].status === 'sent')
      return reply.status(409).send({ error: 'CONFLICT', message: `Campaign is already ${camp[0].status}` })
    const { launchCampaign } = await import('../../services/email-campaigns.js')
    const { queued } = await launchCampaign(id)
    return reply.send({ launched: true, queued })
  })

  app.post('/email/campaigns/:id/cancel', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`
      UPDATE email_campaigns SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${id} AND client_id = ${auth.clientId} AND status IN ('draft', 'scheduled')
    `
    return reply.send({ cancelled: true })
  })

  app.delete('/email/campaigns/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`
      DELETE FROM email_campaigns WHERE id = ${id} AND client_id = ${auth.clientId} AND status IN ('draft', 'scheduled', 'cancelled')
    `
    return reply.status(204).send()
  })

  // ── Usage ──────────────────────────────────────────────────────

  app.get('/usage', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const now          = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

    type MsgCount = { total: string }
    const rows = (await adminDb`
      SELECT COUNT(*)::text AS total FROM messages
      WHERE client_id = ${auth.clientId}
        AND created_at >= ${startOfMonth} AND created_at <= ${endOfMonth}
    `) as unknown as MsgCount[]
    const total = parseInt(rows[0]?.total ?? '0', 10)

    type PlanRow2 = { monthly_message_cap: number | null }
    const planRows = (await adminDb`
      SELECT p.monthly_message_cap FROM clients c JOIN plans p ON p.id = c.plan_id WHERE c.id = ${auth.clientId}
    `) as unknown as PlanRow2[]

    return reply.send({
      messagesIn:         0,
      messagesOut:        total,
      voiceNotesCount:    0,
      scenariosTriggered: 0,
      handoffsCount:      0,
      periodStart:        startOfMonth.toISOString().slice(0, 10),
      periodEnd:          endOfMonth.toISOString().slice(0, 10),
      monthlyLimit:       planRows[0]?.monthly_message_cap ?? null,
    })
  })

  // ── AI REPLY PROFILE (self-service) ───────────────────────────

  app.get('/ai-profile', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type PRow = {
      persona: string; tone: string; system_prompt: string
      permitted_topics: string[]; prohibited_topics: string[]
      escalation_triggers: string[]; max_tokens: number; temperature: number
      ai_reply: boolean
    }
    const rows = (await adminDb`
      SELECT p.*, COALESCE(m.ai_reply, FALSE) AS ai_reply
      FROM   ai_reply_profiles p
      LEFT JOIN module_config m ON m.client_id = p.client_id
      WHERE  p.client_id = ${auth.clientId}
    `) as unknown as PRow[]

    if (!rows[0]) {
      return reply.send({
        exists: false, aiReply: false,
        persona: 'a helpful business assistant',
        tone: 'friendly and professional',
        systemPrompt: "You are a helpful business assistant. Be concise and professional.",
        permittedTopics: [], prohibitedTopics: [],
        escalationTriggers: ['human', 'agent', 'speak to someone', 'call me'],
        maxTokens: 500, temperature: 0.7,
      })
    }

    const p = rows[0]!
    return reply.send({
      exists: true, aiReply: p.ai_reply,
      persona: p.persona, tone: p.tone, systemPrompt: p.system_prompt,
      permittedTopics: p.permitted_topics, prohibitedTopics: p.prohibited_topics,
      escalationTriggers: p.escalation_triggers,
      maxTokens: p.max_tokens, temperature: Number(p.temperature),
    })
  })

  app.put('/ai-profile', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const b = req.body as {
      aiReply?: boolean; persona?: string; tone?: string; systemPrompt?: string
      permittedTopics?: string[]; prohibitedTopics?: string[]
      escalationTriggers?: string[]; maxTokens?: number; temperature?: number
    }

    await adminDb`
      INSERT INTO ai_reply_profiles (
        client_id, persona, tone, system_prompt,
        permitted_topics, prohibited_topics, escalation_triggers, max_tokens, temperature
      ) VALUES (
        ${auth.clientId},
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

    if (b.aiReply !== undefined) {
      await adminDb`
        INSERT INTO module_config (client_id, ai_reply)
        VALUES (${auth.clientId}, ${b.aiReply})
        ON CONFLICT (client_id) DO UPDATE SET ai_reply = ${b.aiReply}, updated_at = NOW()
      `
      if (b.aiReply) {
        await adminDb`UPDATE conversations SET ai_active = TRUE WHERE client_id = ${auth.clientId} AND status = 'active'`
      } else {
        await adminDb`UPDATE conversations SET ai_active = FALSE WHERE client_id = ${auth.clientId}`
      }
    }

    return reply.status(204).send()
  })

  // ── SUBSCRIPTION STATUS ────────────────────────────────────────

  app.get('/subscription', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type SubRow = {
      id: string; status: string; trial_ends_at: string | null
      current_period_start: string | null; current_period_end: string | null
      amount: number | null; currency: string; plan_name: string
    }
    const rows = (await adminDb`
      SELECT s.*, p.display_name AS plan_name
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.client_id = ${auth.clientId}
      ORDER BY s.created_at DESC LIMIT 1
    `) as unknown as SubRow[]

    if (!rows[0]) return reply.send({ status: 'none' })
    const s = rows[0]!
    return reply.send({
      id: s.id, status: s.status, planName: s.plan_name,
      trialEndsAt: s.trial_ends_at, amount: s.amount, currency: s.currency,
      currentPeriodStart: s.current_period_start, currentPeriodEnd: s.current_period_end,
    })
  })

  // ── MESSAGE TEMPLATES (read + per-client) ─────────────────────

  app.get('/message-templates', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type TRow = { id: string; name: string; category: string; content: string; variables: string[]; is_global: boolean }
    const rows = (await adminDb`
      SELECT id, name, category, content, variables, is_global
      FROM message_templates
      WHERE is_global = TRUE OR client_id = ${auth.clientId}
      ORDER BY category, name
    `) as unknown as TRow[]
    return reply.send(rows.map(r => ({ id: r.id, name: r.name, category: r.category, content: r.content, variables: r.variables, isGlobal: r.is_global })))
  })

  app.post('/message-templates', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const b = req.body as { name?: string; category?: string; content?: string; variables?: string[] }
    if (!b.name?.trim() || !b.content?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name and content required' })
    }
    type TIRow = { id: string }
    const rows = (await adminDb`
      INSERT INTO message_templates (client_id, name, category, content, variables, is_global)
      VALUES (${auth.clientId}, ${b.name.trim()}, ${b.category ?? 'general'}, ${b.content.trim()}, ${b.variables ?? []}, FALSE)
      RETURNING id
    `) as unknown as TIRow[]
    return reply.status(201).send({ id: rows[0]!.id, name: b.name.trim(), category: b.category ?? 'general', content: b.content.trim(), variables: b.variables ?? [], isGlobal: false })
  })

  // ── WHATSAPP SELF-CONNECT ──────────────────────────────────────
  // Business requests a QR code to connect their own number.
  // Operator-side session is provisioned first; this returns the session ID
  // and a connect token. The business portal polls for QR via WebSocket.

  app.post('/connect-whatsapp', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return

    const { phoneNumber } = req.body as { phoneNumber?: string }
    if (!phoneNumber?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'phoneNumber is required (E.164 format)' })
    }

    // Check for existing pending/active session
    type SRow = { id: string; status: string }
    const existing = (await adminDb`
      SELECT id, status FROM whatsapp_sessions
      WHERE client_id = ${auth.clientId} AND phone_number = ${phoneNumber.trim()}
      LIMIT 1
    `) as unknown as SRow[]

    let sessionId: string

    if (existing[0]) {
      sessionId = existing[0].id
    } else {
      const rows = (await adminDb`
        INSERT INTO whatsapp_sessions (client_id, phone_number, role, status)
        VALUES (${auth.clientId}, ${phoneNumber.trim()}, 'primary', 'pending_qr')
        RETURNING id
      `) as unknown as Array<{ id: string }>
      sessionId = rows[0]!.id

      await adminDb`
        INSERT INTO warmup_profiles (session_id, client_id, skip_warmup) VALUES (${sessionId}, ${auth.clientId}, true)
        ON CONFLICT DO NOTHING
      `
    }

    // Issue a 30-min token so portal can authenticate the QR WebSocket
    type TRow = { token: string; expires_at: string }
    const tokenRows = (await adminDb`
      INSERT INTO session_connect_tokens (client_id, session_id)
      VALUES (${auth.clientId}, ${sessionId})
      RETURNING token, expires_at
    `) as unknown as TRow[]

    return reply.status(201).send({
      sessionId,
      connectToken: tokenRows[0]!.token,
      expiresAt:    tokenRows[0]!.expires_at,
      qrWsUrl:      `/v1/admin/sessions/${sessionId}/qr`,
    })
  })

  app.get('/whatsapp-sessions', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type SRow = { id: string; phone_number: string; status: string; connected_at: string | null; created_at: string }
    const rows = (await adminDb`
      SELECT id, phone_number, status, connected_at, created_at
      FROM whatsapp_sessions WHERE client_id = ${auth.clientId}
      ORDER BY created_at DESC
    `) as unknown as SRow[]
    return reply.send(rows.map(r => ({
      id: r.id, phoneNumber: r.phone_number, status: r.status,
      connectedAt: r.connected_at, createdAt: r.created_at,
    })))
  })

  // ── OPT-OUT MANAGEMENT (self-service) ─────────────────────────

  app.get('/optouts', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type ORow = { phone_number: string; opted_out_at: string | null; updated_at: string }
    const rows = (await adminDb`
      SELECT phone_number, opted_out_at, updated_at
      FROM optout_registry WHERE client_id = ${auth.clientId} AND opted_out = TRUE
      ORDER BY updated_at DESC LIMIT 200
    `) as unknown as ORow[]
    return reply.send(rows.map(r => ({ phoneNumber: r.phone_number, optedOutAt: r.opted_out_at, updatedAt: r.updated_at })))
  })

  // ── AUTOMATIONS (full self-service CRUD) ──────────────────────

  const E164_AUTO = /^\+[1-9]\d{6,14}$/

  app.get('/automations', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type FRow = { id: string; name: string; description: string | null; trigger_type: string; trigger_key: string | null; status: string; total_enrolled: number; total_completed: number; created_at: string; session_phone: string }
    const rows = (await adminDb`
      SELECT f.id, f.name, f.description, f.trigger_type, f.trigger_key, f.status,
             f.total_enrolled, f.total_completed, f.created_at, s.phone_number AS session_phone
      FROM automation_flows f
      JOIN whatsapp_sessions s ON s.id = f.session_id
      WHERE f.client_id = ${auth.clientId} AND f.status != 'archived'
      ORDER BY f.created_at DESC
    `) as unknown as FRow[]
    return reply.send(rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      triggerType: r.trigger_type, triggerKey: r.trigger_key, status: r.status,
      totalEnrolled: Number(r.total_enrolled), totalCompleted: Number(r.total_completed),
      createdAt: r.created_at, sessionPhone: r.session_phone,
    })))
  })

  app.post('/automations', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const body = req.body as {
      name?: string; description?: string; sessionId?: string
      triggerType?: 'api' | 'manual'
      steps?: { stepType: 'send_message' | 'wait'; content?: string; contentType?: string; delayMinutes?: number }[]
    }
    if (!body.name?.trim() || !body.sessionId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'name and sessionId are required' })
    }
    const sess = (await adminDb`SELECT id FROM whatsapp_sessions WHERE id = ${body.sessionId} AND client_id = ${auth.clientId}`) as unknown as Array<{ id: string }>
    if (!sess[0]) return reply.status(403).send({ error: 'FORBIDDEN', message: 'Session not found' })

    const triggerType = body.triggerType ?? 'manual'
    const triggerKey  = triggerType === 'api' ? randomBytes(12).toString('hex') : null

    type FIRow = { id: string; created_at: string }
    const rows = (await adminDb`
      INSERT INTO automation_flows (client_id, session_id, name, description, trigger_type, trigger_key)
      VALUES (${auth.clientId}, ${body.sessionId}, ${body.name.trim()}, ${body.description ?? null}, ${triggerType}, ${triggerKey})
      RETURNING id, created_at
    `) as unknown as FIRow[]
    const flowId = rows[0]!.id

    const steps = body.steps ?? []
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      await adminDb`
        INSERT INTO automation_steps (flow_id, step_order, step_type, content, content_type, delay_minutes)
        VALUES (${flowId}, ${i}, ${s.stepType}, ${s.content ?? null}, ${s.contentType ?? 'text'}, ${s.delayMinutes ?? 0})
      `
    }
    return reply.status(201).send({ id: flowId, triggerKey, createdAt: rows[0]!.created_at })
  })

  app.get('/automations/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    type FRow2 = { id: string; name: string; description: string | null; trigger_type: string; trigger_key: string | null; status: string; total_enrolled: number; total_completed: number; created_at: string; session_id: string; session_phone: string }
    const flows = (await adminDb`
      SELECT f.*, s.phone_number AS session_phone
      FROM automation_flows f JOIN whatsapp_sessions s ON s.id = f.session_id
      WHERE f.id = ${id} AND f.client_id = ${auth.clientId}
    `) as unknown as FRow2[]
    if (!flows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Flow not found' })

    type SRow = { id: string; step_order: number; step_type: string; content: string | null; content_type: string; delay_minutes: number }
    const steps = (await adminDb`
      SELECT id, step_order, step_type, content, content_type, delay_minutes
      FROM automation_steps WHERE flow_id = ${id} ORDER BY step_order
    `) as unknown as SRow[]

    type CRow = { total: string; active: string; completed: string }
    const counts = (await adminDb`
      SELECT COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE status = 'active')::text AS active,
             COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
      FROM automation_enrollments WHERE flow_id = ${id}
    `) as unknown as CRow[]

    const f = flows[0]!
    return reply.send({
      id: f.id, name: f.name, description: f.description,
      triggerType: f.trigger_type, triggerKey: f.trigger_key, status: f.status,
      sessionId: f.session_id, sessionPhone: f.session_phone,
      totalEnrolled: Number(f.total_enrolled), totalCompleted: Number(f.total_completed),
      createdAt: f.created_at,
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

  app.patch('/automations/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const body = req.body as { name?: string; description?: string; status?: 'active' | 'paused' }
    await adminDb`
      UPDATE automation_flows SET
        name        = COALESCE(${body.name        ?? null}, name),
        description = COALESCE(${body.description ?? null}, description),
        status      = COALESCE(${body.status      ?? null}, status),
        updated_at  = NOW()
      WHERE id = ${id} AND client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  app.put('/automations/:id/steps', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const own = (await adminDb`SELECT id FROM automation_flows WHERE id = ${id} AND client_id = ${auth.clientId}`) as unknown as Array<{ id: string }>
    if (!own[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Flow not found' })

    const body = req.body as { steps: { stepType: 'send_message' | 'wait'; content?: string; contentType?: string; delayMinutes?: number }[] }
    await adminDb`DELETE FROM automation_steps WHERE flow_id = ${id}`
    for (let i = 0; i < body.steps.length; i++) {
      const s = body.steps[i]!
      await adminDb`
        INSERT INTO automation_steps (flow_id, step_order, step_type, content, content_type, delay_minutes)
        VALUES (${id}, ${i}, ${s.stepType}, ${s.content ?? null}, ${s.contentType ?? 'text'}, ${s.delayMinutes ?? 0})
      `
    }
    return reply.status(204).send()
  })

  app.delete('/automations/:id', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    await adminDb`UPDATE automation_flows SET status = 'archived', updated_at = NOW() WHERE id = ${id} AND client_id = ${auth.clientId}`
    return reply.status(204).send()
  })

  app.post('/automations/:id/enroll', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    type FlowStatus = { status: string }
    const flows = (await adminDb`SELECT status FROM automation_flows WHERE id = ${id} AND client_id = ${auth.clientId}`) as unknown as FlowStatus[]
    if (!flows[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Flow not found' })
    if (flows[0].status !== 'active') return reply.status(409).send({ error: 'CONFLICT', message: 'Flow must be active to enroll contacts' })

    const body = req.body as { contacts?: { phoneNumber: string; name?: string }[] }
    if (!body.contacts?.length) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'contacts array is required' })

    let enrolled = 0
    for (const c of body.contacts) {
      if (!E164_AUTO.test(c.phoneNumber)) continue
      try {
        await adminDb`
          INSERT INTO automation_enrollments (flow_id, client_id, phone_number, name, next_step_at)
          VALUES (${id}, ${auth.clientId}, ${c.phoneNumber}, ${c.name ?? null}, NOW())
          ON CONFLICT (flow_id, phone_number) DO NOTHING
        `
        enrolled++
      } catch { /* skip */ }
    }
    if (enrolled > 0) {
      await adminDb`UPDATE automation_flows SET total_enrolled = total_enrolled + ${enrolled}, updated_at = NOW() WHERE id = ${id}`
    }
    return reply.send({ enrolled })
  })

  app.get('/automations/:id/enrollments', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id } = req.params as { id: string }
    const own = (await adminDb`SELECT id FROM automation_flows WHERE id = ${id} AND client_id = ${auth.clientId}`) as unknown as Array<{ id: string }>
    if (!own[0]) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Flow not found' })

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

  app.delete('/automations/:id/enrollments/:enrollmentId', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    const { id, enrollmentId } = req.params as { id: string; enrollmentId: string }
    await adminDb`
      UPDATE automation_enrollments SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${enrollmentId} AND flow_id = ${id} AND client_id = ${auth.clientId}
    `
    return reply.status(204).send()
  })

  // ── BROADCASTS (self-service, read-only) ──────────────────────

  app.get('/broadcasts', async (req, reply) => {
    const auth = getBizAuth(req, reply)
    if (!auth) return
    type BRow = { id: string; name: string; status: string; total_recipients: number; total_sent: number; total_failed: number; created_at: string }
    const rows = (await adminDb`
      SELECT id, name, status, total_recipients, total_sent, total_failed, created_at
      FROM whatsapp_broadcasts WHERE client_id = ${auth.clientId}
      ORDER BY created_at DESC LIMIT 50
    `) as unknown as BRow[]
    return reply.send(rows.map(r => ({
      id: r.id, name: r.name, status: r.status,
      totalRecipients: Number(r.total_recipients), totalSent: Number(r.total_sent),
      totalFailed: Number(r.total_failed), createdAt: r.created_at,
    })))
  })
}

export default businessRoutes
