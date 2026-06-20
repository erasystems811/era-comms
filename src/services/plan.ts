// ── PLAN ENFORCEMENT ──────────────────────────────────────────
//
// Plan limits are checked at message-queue time (sendMessage) and
// incremented at confirmed-send time (session-worker).
//
// DB is the source of truth for limits; Redis counters are the fast
// path for both checks and increments. Counter keys come from
// db/redis.ts (limitKey / incrementLimit / currentLimit).
//
// Plan data is cached per-client in Redis for 5 minutes to avoid a
// DB round-trip on every message send.

import { adminDb } from '../db/client.js'
import { redis, incrementLimit, currentLimit } from '../db/redis.js'
import { PlanLimitError } from '../shared/errors.js'

type PlanLimits = {
  monthlyMessageCap: number | null
  dailyMessageCap:   number | null
  hourlyMessageCap:  number | null
  aiEnabled:         boolean
}

const PLAN_CACHE_TTL = 300  // 5 minutes

type PlanRow = {
  monthly_message_cap: number | null
  daily_message_cap:   number | null
  hourly_message_cap:  number | null
  ai_enabled:          boolean
}

async function loadPlanLimits(clientId: string): Promise<PlanLimits> {
  const cacheKey = `plan_limits:${clientId}`
  const cached   = await redis.get(cacheKey)
  if (cached) return JSON.parse(cached) as PlanLimits

  const rows = (await adminDb`
    SELECT p.monthly_message_cap,
           p.daily_message_cap,
           p.hourly_message_cap,
           p.ai_enabled
    FROM   plans p
    JOIN   clients c ON c.plan_id = p.id
    WHERE  c.id = ${clientId}
  `) as unknown as PlanRow[]

  const row = rows[0]

  // Unknown client — fail open (plan enforcement is a safeguard, not auth)
  const limits: PlanLimits = row
    ? {
        monthlyMessageCap: row.monthly_message_cap,
        dailyMessageCap:   row.daily_message_cap,
        hourlyMessageCap:  row.hourly_message_cap,
        aiEnabled:         row.ai_enabled,
      }
    : { monthlyMessageCap: null, dailyMessageCap: null, hourlyMessageCap: null, aiEnabled: true }

  await redis.set(cacheKey, JSON.stringify(limits), 'EX', PLAN_CACHE_TTL)
  return limits
}

// Called at queue time (sendMessage) — throws PlanLimitError if any cap is hit.
export async function checkMessagePlanLimits(clientId: string): Promise<void> {
  const limits = await loadPlanLimits(clientId)

  if (limits.monthlyMessageCap !== null) {
    const count = await currentLimit(clientId, 'monthly')
    if (count >= limits.monthlyMessageCap) throw new PlanLimitError('monthly')
  }

  if (limits.dailyMessageCap !== null) {
    const count = await currentLimit(clientId, 'daily')
    if (count >= limits.dailyMessageCap) throw new PlanLimitError('daily')
  }

  if (limits.hourlyMessageCap !== null) {
    const count = await currentLimit(clientId, 'hourly')
    if (count >= limits.hourlyMessageCap) throw new PlanLimitError('hourly')
  }
}

// Called at confirmed-send time (session-worker) — increments all three
// Redis counters atomically. Self-expiring keys, no cleanup needed.
export async function recordMessageSent(clientId: string): Promise<void> {
  await Promise.all([
    incrementLimit(clientId, 'hourly'),
    incrementLimit(clientId, 'daily'),
    incrementLimit(clientId, 'monthly'),
  ])
}

// Expose plan limits for the admin usage endpoint.
export async function getClientPlanLimits(clientId: string): Promise<PlanLimits> {
  return loadPlanLimits(clientId)
}

// Invalidate cached plan limits — call when a client's plan changes.
export async function invalidatePlanCache(clientId: string): Promise<void> {
  await redis.del(`plan_limits:${clientId}`)
}
