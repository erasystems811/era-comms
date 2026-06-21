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
      conversation_inbox: boolean; analytics: boolean
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
        moduleConfig: {
          knowledgeBase:     mod.knowledge_base,
          autoGreet:         mod.auto_greet,
          businessHours:     mod.business_hours,
          scenarios:         mod.scenarios,
          humanHandoff:      mod.human_handoff,
          voiceNotes:        mod.voice_notes,
          conversationInbox: mod.conversation_inbox,
          analytics:         mod.analytics,
        },
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
      conversation_inbox: boolean; analytics: boolean
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
      moduleConfig: {
        knowledgeBase:     mod.knowledge_base,
        autoGreet:         mod.auto_greet,
        businessHours:     mod.business_hours,
        scenarios:         mod.scenarios,
        humanHandoff:      mod.human_handoff,
        voiceNotes:        mod.voice_notes,
        conversationInbox: mod.conversation_inbox,
        analytics:         mod.analytics,
      },
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
      conversationInbox: boolean; analytics: boolean
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
    if (period) {
      const parts = period.split('-')
      const yr = parseInt(parts[0] ?? '2000', 10)
      const mo = parseInt(parts[1] ?? '1', 10)
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
}

export default businessRoutes
