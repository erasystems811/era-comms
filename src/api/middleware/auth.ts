import { createHash } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { redis } from '../../db/redis.js'
import {
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
} from '../../shared/errors.js'

// 200 requests per 60 seconds per API key
const RATE_LIMIT_MAX = 200
const RATE_LIMIT_WINDOW_S = 60

type KeyRow = {
  id: string
  client_id: string
  scopes: string[]
  client_type: string
}

export async function authHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // WebSocket connections cannot set headers in browsers.
  // Support api_key query param as fallback for QR stream clients.
  const rawKey =
    (req.headers['x-api-key'] as string | undefined) ??
    (req.query as Record<string, string | undefined>)['api_key']

  if (!rawKey) throw new AuthenticationError()

  const keyHash = createHash('sha256').update(rawKey).digest('hex')

  // Rate limit: Redis INCR per 60-second minute bucket.
  // Runs before the DB lookup — cheaper and limits brute-force attempts.
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_S)
  const rlKey = `rl:${keyHash}:${bucket}`
  const count = await redis.incr(rlKey)
  if (count === 1) await redis.expire(rlKey, RATE_LIMIT_WINDOW_S * 2)
  if (count > RATE_LIMIT_MAX) throw new RateLimitError(RATE_LIMIT_WINDOW_S)

  // Filter active keys only — avoids leaking whether a revoked key existed
  const rows = (await adminDb`
    SELECT ak.id,
           ak.client_id,
           ak.scopes,
           c.type AS client_type
    FROM   api_keys ak
    JOIN   clients  c ON c.id = ak.client_id
    WHERE  ak.key_hash  = ${keyHash}
      AND  ak.status    = 'active'
      AND  (ak.expires_at IS NULL OR ak.expires_at > NOW())
  `) as unknown as KeyRow[]

  const key = rows[0]
  if (!key) throw new AuthenticationError()

  req.clientId = key.client_id
  req.apiKeyId = key.id
  req.scopes = Array.isArray(key.scopes) ? key.scopes : []
  req.clientType = key.client_type as 'internal' | 'external'

  // Fire-and-forget — don't block the request on this write
  void adminDb`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${key.id}`
}

export function assertScope(req: FastifyRequest, scope: string): void {
  if (!req.scopes.includes(scope)) {
    throw new AuthorizationError(`API key requires the '${scope}' scope for this operation`)
  }
}
