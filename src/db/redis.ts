import { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

function createClient(name: string): Redis {
  const client = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,  // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  })

  client.on('connect', () => logger.info({ name }, 'Redis connected'))
  client.on('error', (err: Error) => logger.error({ name, err }, 'Redis error'))
  client.on('close', () => logger.warn({ name }, 'Redis connection closed'))

  return client
}

// General-purpose client: caching, rate limiting, pub/sub, session cache
// General-purpose client: caching, rate limiting, pub/sub, session cache
export const redis = createClient('general')

// BullMQ requires its own dedicated ioredis connection
export const queueRedis = createClient('queue')

// ── PLAN LIMIT ENFORCEMENT ────────────────────────────────────
//
// Enforcement uses Redis atomic INCR counters, not database queries.
// Keys expire automatically — no cleanup required.
//
// Counter key format: limit:{clientId}:{scope}:{period}
// where period is YYYY-MM for monthly, YYYY-MM-DD for daily, YYYY-MM-DDTHH for hourly

export function limitKey(clientId: string, scope: 'hourly' | 'daily' | 'monthly'): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const h = String(now.getUTCHours()).padStart(2, '0')

  const period =
    scope === 'monthly' ? `${y}-${m}` :
    scope === 'daily'   ? `${y}-${m}-${d}` :
                          `${y}-${m}-${d}T${h}`

  return `limit:${clientId}:${scope}:${period}`
}

const TTL: Record<string, number> = {
  hourly:  3600 * 2,   // 2 hours — covers clock edge cases
  daily:   86400 * 2,
  monthly: 86400 * 35,
}

// Atomically increment usage counter and return the new value.
// Sets TTL on first write so keys self-expire.
export async function incrementLimit(
  clientId: string,
  scope: 'hourly' | 'daily' | 'monthly',
  by = 1,
): Promise<number> {
  const key = limitKey(clientId, scope)
  const pipeline = redis.pipeline()
  pipeline.incrby(key, by)
  pipeline.expire(key, TTL[scope] ?? 3600, 'NX')  // NX = only set TTL if not already set
  const [[, count]] = await pipeline.exec() as [[null, number]]
  return count
}

// Read current counter without incrementing (for pre-flight checks)
export async function currentLimit(
  clientId: string,
  scope: 'hourly' | 'daily' | 'monthly',
): Promise<number> {
  const val = await redis.get(limitKey(clientId, scope))
  return val ? parseInt(val, 10) : 0
}

export async function closeRedis(): Promise<void> {
  await redis.quit()
  await queueRedis.quit()
}
