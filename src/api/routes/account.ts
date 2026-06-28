import type { FastifyPluginAsync } from 'fastify'
import { adminDb } from '../../db/client.js'
import { currentLimit } from '../../db/redis.js'

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
}

export default accountRoutes
