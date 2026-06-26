import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'

function assertOperator(req: FastifyRequest, reply: FastifyReply): boolean {
  const raw    = req.headers['x-operator-secret']
  const secret = Array.isArray(raw) ? raw[0] : raw
  if (!secret || secret !== config.operatorSecret) {
    void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid operator secret' })
    return false
  }
  return true
}

function parsePeriod(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number)
  const start  = new Date(y!, m! - 1, 1)
  const end    = new Date(y!, m!, 0) // last day of month
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  }
}

function currentPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const observabilityRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /events ────────────────────────────────────────────────

  app.get('/events', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const q = req.query as {
      businessId?: string; eventType?: string; severity?: string
      from?: string; to?: string; limit?: string; offset?: string
    }

    const limit  = Math.min(parseInt(q.limit  ?? '500', 10), 1000)
    const offset = parseInt(q.offset ?? '0', 10)

    type EventRow = {
      id: string; client_id: string | null; client_name: string | null
      session_id: string | null; event_type: string; severity: string
      detail: string; metadata: Record<string, unknown>; created_at: string
    }

    const rows = (await adminDb`
      SELECT pe.id, pe.client_id, c.name AS client_name,
             pe.session_id, pe.event_type, pe.severity, pe.detail, pe.metadata, pe.created_at
      FROM   platform_events pe
      LEFT   JOIN clients c ON c.id = pe.client_id
      WHERE  TRUE
        ${q.businessId ? adminDb`AND pe.client_id = ${q.businessId}` : adminDb``}
        ${q.eventType  ? adminDb`AND pe.event_type = ${q.eventType}`  : adminDb``}
        ${q.severity   ? adminDb`AND pe.severity   = ${q.severity}`   : adminDb``}
        ${q.from ? adminDb`AND pe.created_at >= ${new Date(q.from + 'T00:00:00Z')}` : adminDb``}
        ${q.to   ? adminDb`AND pe.created_at <= ${new Date(q.to   + 'T23:59:59Z')}` : adminDb``}
      ORDER BY pe.created_at DESC
      LIMIT  ${limit} OFFSET ${offset}
    `) as unknown as EventRow[]

    return rows.map(e => ({
      id:           e.id,
      businessId:   e.client_id,
      businessName: e.client_name,
      sessionId:    e.session_id,
      eventType:    e.event_type,
      severity:     e.severity,
      detail:       e.detail,
      metadata:     e.metadata ?? {},
      createdAt:    e.created_at,
    }))
  })

  // ── GET /events/debug ─────────────────────────────────────
  // Returns the last 20 raw rows from platform_events, no filters.
  // Use this to check if events are reaching the DB at all.

  app.get('/events/debug', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const rows = await adminDb`
      SELECT id, event_type, severity, detail, created_at
      FROM   platform_events
      ORDER  BY created_at DESC
      LIMIT  20
    `
    return rows
  })

  // ── GET /audit ─────────────────────────────────────────────────

  app.get('/audit', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const q = req.query as {
      businessId?: string; from?: string; to?: string; limit?: string
    }

    const limit = Math.min(parseInt(q.limit ?? '500', 10), 1000)

    type AuditRow = {
      id: string; actor: string; actor_id: string | null; actor_label: string
      action: string; target: string; target_id: string | null; detail: string; created_at: string
    }

    const rows = (await adminDb`
      SELECT id, actor, actor_id, actor_label, action, target, target_id, detail, created_at
      FROM   audit_log
      WHERE  TRUE
        ${q.businessId ? adminDb`AND (actor_id = ${q.businessId} OR target_id = ${q.businessId})` : adminDb``}
        ${q.from ? adminDb`AND created_at >= ${new Date(q.from + 'T00:00:00Z')}` : adminDb``}
        ${q.to   ? adminDb`AND created_at <= ${new Date(q.to   + 'T23:59:59Z')}` : adminDb``}
      ORDER BY created_at DESC
      LIMIT  ${limit}
    `) as unknown as AuditRow[]

    return rows.map(e => ({
      id:         e.id,
      actor:      e.actor,
      actorId:    e.actor_id,
      actorLabel: e.actor_label,
      action:     e.action,
      target:     e.target,
      targetId:   e.target_id,
      detail:     e.detail,
      createdAt:  e.created_at,
    }))
  })

  // ── GET /usage ─────────────────────────────────────────────────

  app.get('/usage', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const q      = req.query as { period?: string }
    const period = q.period ?? currentPeriod()
    const { start, end } = parsePeriod(period)

    type UsageAgg = {
      client_id: string; client_name: string; plan_name: string; plan_display: string
      billing_model: string; monthly_fee: string | null; price_per_message: string | null
      monthly_message_cap: number | null
      event_type: string; total_quantity: string; event_count: string
    }

    const rows = (await adminDb`
      SELECT c.id AS client_id, c.name AS client_name, p.name AS plan_name,
             p.display_name AS plan_display, p.billing_model, p.monthly_fee,
             p.price_per_message, p.monthly_message_cap,
             ud.event_type, SUM(ud.total_quantity)::text AS total_quantity, SUM(ud.event_count)::text AS event_count
      FROM   clients c
      JOIN   plans p ON p.id = c.plan_id
      JOIN   usage_daily ud ON ud.client_id = c.id
             AND ud.bucket >= ${start + 'T00:00:00Z'} AND ud.bucket <= ${end + 'T23:59:59Z'}
      WHERE  c.status = 'active'
      GROUP BY c.id, c.name, p.name, p.display_name, p.billing_model, p.monthly_fee, p.price_per_message, p.monthly_message_cap, ud.event_type
    `) as unknown as UsageAgg[]

    const byClient: Record<string, {
      businessId: string; businessName: string; planName: string
      messagesIn: number; messagesOut: number; voiceNotesCount: number
      scenariosTriggered: number; aiTokensUsed: number; handoffsCount: number
      pricePerMsg: number | null; monthlyFee: number | null
      billingModel: string; monthlyMessageCap: number | null
    }> = {}

    for (const r of rows) {
      if (!byClient[r.client_id]) {
        byClient[r.client_id] = {
          businessId: r.client_id, businessName: r.client_name, planName: r.plan_display,
          messagesIn: 0, messagesOut: 0, voiceNotesCount: 0,
          scenariosTriggered: 0, aiTokensUsed: 0, handoffsCount: 0,
          pricePerMsg: r.price_per_message ? parseFloat(r.price_per_message) : null,
          monthlyFee: r.monthly_fee ? parseFloat(r.monthly_fee) : null,
          billingModel: r.billing_model,
          monthlyMessageCap: r.monthly_message_cap,
        }
      }
      const c = byClient[r.client_id]!
      const qty = parseFloat(r.total_quantity ?? '0')
      const cnt = parseInt(r.event_count ?? '0', 10)
      if (r.event_type === 'message_received')   c.messagesIn         += cnt
      if (r.event_type === 'message_sent')        c.messagesOut        += cnt
      if (r.event_type === 'voice_call_initiated')c.voiceNotesCount    += cnt
      if (r.event_type === 'ai_turn')             c.scenariosTriggered += cnt
      if (r.event_type === 'ai_tokens')           c.aiTokensUsed       += Math.round(qty)
      if (r.event_type === 'webhook_delivered')   c.handoffsCount      += cnt
    }

    return Object.values(byClient).map(c => {
      const totalMsgs = c.messagesIn + c.messagesOut
      const estimatedCost = c.billingModel === 'usage_based' && c.pricePerMsg != null
        ? c.pricePerMsg * totalMsgs
        : c.billingModel === 'plan_based' && c.monthlyFee != null
        ? c.monthlyFee
        : null
      const usagePercent = c.monthlyMessageCap ? (totalMsgs / c.monthlyMessageCap) * 100 : null

      return {
        businessId:         c.businessId,
        businessName:       c.businessName,
        planName:           c.planName,
        messagesIn:         c.messagesIn,
        messagesOut:        c.messagesOut,
        voiceNotesCount:    c.voiceNotesCount,
        scenariosTriggered: c.scenariosTriggered,
        aiTokensUsed:       c.aiTokensUsed,
        handoffsCount:      c.handoffsCount,
        periodStart:        start,
        periodEnd:          end,
        estimatedCost:      estimatedCost ? Math.round(estimatedCost * 100) / 100 : null,
        planLimit:          c.monthlyMessageCap,
        usagePercent:       usagePercent ? Math.round(usagePercent * 10) / 10 : null,
      }
    })
  })

  // ── GET /usage/:businessId ─────────────────────────────────────

  app.get('/usage/:businessId', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { businessId } = req.params as { businessId: string }
    const q = req.query as { period?: string }
    const period = q.period ?? currentPeriod()
    const { start, end } = parsePeriod(period)

    type ClientRow = {
      id: string; name: string; plan_name: string; billing_model: string
      monthly_fee: string | null; price_per_message: string | null; monthly_message_cap: number | null
    }

    const clients = (await adminDb`
      SELECT c.id, c.name, p.display_name AS plan_name, p.billing_model,
             p.monthly_fee, p.price_per_message, p.monthly_message_cap
      FROM clients c JOIN plans p ON p.id = c.plan_id WHERE c.id = ${businessId}
    `) as unknown as ClientRow[]

    if (!clients[0]) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Business not found' })
    }

    const client = clients[0]!

    type UsageRow = { event_type: string; total_quantity: string; event_count: string }

    const rows = (await adminDb`
      SELECT event_type, SUM(total_quantity)::text AS total_quantity, SUM(event_count)::text AS event_count
      FROM   usage_daily
      WHERE  client_id = ${businessId}
        AND  bucket >= ${start + 'T00:00:00Z'} AND bucket <= ${end + 'T23:59:59Z'}
      GROUP BY event_type
    `) as unknown as UsageRow[]

    let messagesIn = 0, messagesOut = 0, voiceNotesCount = 0
    let scenariosTriggered = 0, aiTokensUsed = 0, handoffsCount = 0

    for (const r of rows) {
      const qty = parseFloat(r.total_quantity ?? '0')
      const cnt = parseInt(r.event_count ?? '0', 10)
      if (r.event_type === 'message_received')    messagesIn          += cnt
      if (r.event_type === 'message_sent')         messagesOut         += cnt
      if (r.event_type === 'voice_call_initiated') voiceNotesCount     += cnt
      if (r.event_type === 'ai_turn')              scenariosTriggered  += cnt
      if (r.event_type === 'ai_tokens')            aiTokensUsed        += Math.round(qty)
      if (r.event_type === 'webhook_delivered')    handoffsCount       += cnt
    }

    const totalMsgs = messagesIn + messagesOut
    const pricePerMsg = client.price_per_message ? parseFloat(client.price_per_message) : null
    const monthlyFee  = client.monthly_fee ? parseFloat(client.monthly_fee) : null
    const estimatedCost = client.billing_model === 'usage_based' && pricePerMsg != null
      ? pricePerMsg * totalMsgs
      : client.billing_model === 'plan_based' && monthlyFee != null
      ? monthlyFee : null
    const usagePercent = client.monthly_message_cap
      ? (totalMsgs / client.monthly_message_cap) * 100 : null

    return {
      businessId,
      businessName:       client.name,
      planName:           client.plan_name,
      messagesIn, messagesOut, voiceNotesCount,
      scenariosTriggered, aiTokensUsed, handoffsCount,
      periodStart:  start,
      periodEnd:    end,
      estimatedCost: estimatedCost ? Math.round(estimatedCost * 100) / 100 : null,
      planLimit:    client.monthly_message_cap,
      usagePercent: usagePercent ? Math.round(usagePercent * 10) / 10 : null,
    }
  })

  // ── GET /investigate ───────────────────────────────────────────

  app.get('/investigate', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const q = (req.query as { q?: string }).q ?? ''
    const search = `%${q}%`

    type EventRow  = { id: string; client_id: string | null; client_name: string | null; session_id: string | null; event_type: string; severity: string; detail: string; metadata: Record<string, unknown>; created_at: string }
    type AuditRow2 = { id: string; actor: string; actor_id: string | null; actor_label: string; action: string; target: string; target_id: string | null; detail: string; created_at: string }
    type AlertRow  = { id: string; client_id: string | null; client_name: string | null; session_id: string | null; alert_type: string; severity: string; message: string; resolved_at: Date | null; created_at: string }

    const [eventRows, auditRows, alertRows] = await Promise.all([
      adminDb`
        SELECT pe.id, pe.client_id, c.name AS client_name, pe.session_id,
               pe.event_type, pe.severity, pe.detail, pe.metadata, pe.created_at
        FROM   platform_events pe LEFT JOIN clients c ON c.id = pe.client_id
        WHERE  pe.detail ILIKE ${search} OR c.name ILIKE ${search}
        ORDER BY pe.created_at DESC LIMIT 50
      ` as unknown as Promise<EventRow[]>,
      adminDb`
        SELECT id, actor, actor_id, actor_label, action, target, target_id, detail, created_at
        FROM   audit_log
        WHERE  actor_label ILIKE ${search} OR action ILIKE ${search} OR detail ILIKE ${search}
        ORDER BY created_at DESC LIMIT 50
      ` as unknown as Promise<AuditRow2[]>,
      adminDb`
        SELECT ah.id, ah.client_id, c.name AS client_name, ah.session_id,
               ah.alert_type, ah.severity, ah.message, ah.resolved_at, ah.created_at
        FROM   alert_history ah LEFT JOIN clients c ON c.id = ah.client_id
        WHERE  ah.message ILIKE ${search} OR c.name ILIKE ${search}
        ORDER BY ah.created_at DESC LIMIT 50
      ` as unknown as Promise<AlertRow[]>,
    ])

    return {
      events: eventRows.map(e => ({
        id: e.id, businessId: e.client_id, businessName: e.client_name, sessionId: e.session_id,
        eventType: e.event_type, severity: e.severity, detail: e.detail, metadata: e.metadata ?? {}, createdAt: e.created_at,
      })),
      audit: auditRows.map(e => ({
        id: e.id, actor: e.actor, actorId: e.actor_id, actorLabel: e.actor_label,
        action: e.action, target: e.target, targetId: e.target_id, detail: e.detail, createdAt: e.created_at,
      })),
      alerts: alertRows.map(a => ({
        id: a.id, businessId: a.client_id, businessName: a.client_name, sessionId: a.session_id,
        type: a.alert_type, severity: a.severity, message: a.message,
        resolved: !!a.resolved_at, resolvedAt: a.resolved_at, createdAt: a.created_at,
      })),
    }
  })
}

export default observabilityRoutes
