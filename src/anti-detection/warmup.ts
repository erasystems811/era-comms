// ── WARMUP ENFORCEMENT ────────────────────────────────────────
//
// Each WhatsApp number follows a warmup curve to avoid triggering
// spam detection. The curve defines daily send caps that ramp up
// over ~30 days from 5 msg/day to 500 msg/day.
//
// Daily counts are tracked in Redis (warmup:{sessionId}:daily:{date})
// with a 48-hour TTL. The DB profile is the source of truth for caps
// and content stage; Redis is the fast counter.

import { adminDb } from '../db/client.js'
import { redis } from '../db/redis.js'
import type { WarmupStage } from './jitter.js'

type CurvePoint    = { day: number; cap: number }
type ContentStage  = { until_day?: number; from_day?: number; guidance: string }

type ProfileRow = {
  volume_curve:   CurvePoint[]
  content_stages: ContentStage[]
  started_at:     string
  skip_warmup:    boolean
  is_complete:    boolean
}

export interface WarmupCheck {
  allowed:    boolean
  stage:      WarmupStage
  cap:        number        // Infinity when unrestricted
  sentToday:  number
  currentDay: number
  reason?:    string        // set when allowed = false
}

// ── helpers ───────────────────────────────────────────────────

function dailyKey(sessionId: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `warmup:${sessionId}:daily:${date}`
}

// Linear interpolation between volume_curve knots.
// Before first point: use first cap. After last: use last cap.
function interpolateCap(curve: CurvePoint[], day: number): number {
  if (curve.length === 0) return Infinity
  const sorted = [...curve].sort((a, b) => a.day - b.day)
  if (day <= sorted[0]!.day) return sorted[0]!.cap
  if (day >= sorted[sorted.length - 1]!.day) return sorted[sorted.length - 1]!.cap

  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]!
    const hi = sorted[i + 1]!
    if (day >= lo.day && day <= hi.day) {
      const ratio = (day - lo.day) / (hi.day - lo.day)
      return Math.round(lo.cap + (hi.cap - lo.cap) * ratio)
    }
  }
  return Infinity
}

// First matching stage rule wins.
function resolveStage(stages: ContentStage[], day: number): WarmupStage {
  for (const s of stages) {
    if (s.until_day !== undefined && day <= s.until_day) {
      return s.guidance as WarmupStage
    }
    if (s.from_day !== undefined && day >= s.from_day) {
      return s.guidance as WarmupStage
    }
  }
  return 'unrestricted'
}

// ── public API ────────────────────────────────────────────────

export async function checkWarmup(sessionId: string): Promise<WarmupCheck> {
  const rows = (await adminDb`
    SELECT volume_curve, content_stages, started_at, skip_warmup, is_complete
    FROM   warmup_profiles
    WHERE  session_id = ${sessionId}
  `) as unknown as ProfileRow[]

  const profile = rows[0]

  if (!profile || profile.skip_warmup || profile.is_complete) {
    return { allowed: true, stage: 'unrestricted', cap: Infinity, sentToday: 0, currentDay: 0 }
  }

  const startedAt  = new Date(profile.started_at)
  const currentDay = Math.max(1, Math.ceil((Date.now() - startedAt.getTime()) / 86_400_000))
  const cap        = interpolateCap(profile.volume_curve, currentDay)
  const stage      = resolveStage(profile.content_stages, currentDay)

  const sentStr  = await redis.get(dailyKey(sessionId))
  const sentToday = parseInt(sentStr ?? '0', 10)

  if (sentToday >= cap) {
    return {
      allowed: false, stage, cap, sentToday, currentDay,
      reason: 'daily_warmup_cap_exceeded',
    }
  }

  return { allowed: true, stage, cap, sentToday, currentDay }
}

// Called immediately after a successful send to count against today's cap.
export async function incrementDailyCount(sessionId: string): Promise<void> {
  const key   = dailyKey(sessionId)
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, 60 * 60 * 48)
  }
}
