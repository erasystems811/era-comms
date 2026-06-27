import { initAuthCreds } from '@whiskeysockets/baileys'

// Baileys stores keys as Uint8Array / Buffer. Plain JSON.stringify serialises
// Uint8Array as {"0":1,"1":2,...} which JSON.parse brings back as a plain object
// — not a Buffer — causing ERR_INVALID_ARG_TYPE in the noise-protocol handshake.
// These replacer/reviver round-trip everything through {type:'Buffer',data:[...]}.
const bufReplacer = (_k: string, v: unknown) =>
  v instanceof Uint8Array || Buffer.isBuffer(v)
    ? { type: 'Buffer', data: Array.from(v as Uint8Array) }
    : v

const bufReviver = (_k: string, v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (o['type'] === 'Buffer' && Array.isArray(o['data']))
      return Buffer.from(o['data'] as number[])
  }
  return v
}
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys'
import { redis } from '../db/redis.js'
import { adminDb } from '../db/client.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { encrypt, decrypt } from './crypto.js'
import { KEY } from '../queues/definitions.js'

// ── CREDENTIAL PERSISTENCE ────────────────────────────────────
//
// Source of truth: PostgreSQL (encrypted AES-256-GCM).
// Fast path: Redis (plaintext JSON cache, acceptable to be cold).
//
// Losing Redis never causes a QR re-scan — the supervisor loads
// credentials from PostgreSQL on session start and warms the cache.
// The worker then reads from Redis on every reconnect.
//
// Key state (pre-keys, sessions, sender-keys) is Redis-only.
// These can be lost without losing the session — WhatsApp will
// resync them on the next message. The auth creds are the critical
// material that must survive Redis wipes.

export async function loadCredentials(
  sessionId: string,
): Promise<AuthenticationState['creds'] | null> {
  // Try Redis cache first
  const cached = await redis.get(KEY.sessionCreds(sessionId))
  if (cached) {
    return JSON.parse(cached, bufReviver) as AuthenticationState['creds']
  }

  // Fall back to PostgreSQL
  const rows = await adminDb<
    Array<{
      credentials_encrypted: string | null
      credentials_iv: string | null
      credentials_tag: string | null
    }>
  >`
    SELECT credentials_encrypted, credentials_iv, credentials_tag
    FROM whatsapp_sessions
    WHERE id = ${sessionId}
  `

  const row = rows[0]
  if (!row?.credentials_encrypted || !row.credentials_iv || !row.credentials_tag) {
    return null
  }

  try {
    const plaintext = decrypt(
      {
        encrypted: row.credentials_encrypted,
        iv: row.credentials_iv,
        tag: row.credentials_tag,
      },
      config.encryption.sessionCredentialsKey,
    )

    const creds = JSON.parse(plaintext, bufReviver) as AuthenticationState['creds']

    // Warm the cache for subsequent reconnects
    await redis.set(KEY.sessionCreds(sessionId), plaintext)

    return creds
  } catch (err) {
    logger.error({ sessionId, err }, 'Failed to decrypt session credentials')
    return null
  }
}

export async function saveCredentials(
  sessionId: string,
  creds: AuthenticationState['creds'],
): Promise<void> {
  const plaintext = JSON.stringify(creds, bufReplacer)
  const payload = encrypt(plaintext, config.encryption.sessionCredentialsKey)

  // Write to PostgreSQL (source of truth) and Redis cache atomically from
  // the caller's perspective — PG write first so Redis is never ahead.
  await adminDb`
    UPDATE whatsapp_sessions
    SET credentials_encrypted  = ${payload.encrypted},
        credentials_iv         = ${payload.iv},
        credentials_tag        = ${payload.tag},
        credentials_updated_at = NOW()
    WHERE id = ${sessionId}
  `

  await redis.set(KEY.sessionCreds(sessionId), plaintext)
}

export async function clearCredentialCache(sessionId: string): Promise<void> {
  await redis.del(KEY.sessionCreds(sessionId))
}

// Wipes credentials from both Redis and PostgreSQL so the next connect()
// call generates a fresh QR. Used when WhatsApp logs out the session
// (e.g. user tapped "Log out from all devices") so it can be re-paired
// without needing to delete and recreate the session.
export async function clearCredentials(sessionId: string): Promise<void> {
  await Promise.all([
    redis.del(KEY.sessionCreds(sessionId)),
    adminDb`
      UPDATE whatsapp_sessions
      SET credentials_encrypted  = NULL,
          credentials_iv         = NULL,
          credentials_tag        = NULL,
          credentials_updated_at = NOW()
      WHERE id = ${sessionId}
    `,
  ])
}

// ── BAILEYS AUTH STATE FACTORY ────────────────────────────────
//
// Returns the AuthenticationState object Baileys expects.
// This is passed directly to makeWASocket({ auth: ... }).

export async function makeAuthState(
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const stored = await loadCredentials(sessionId)
  const creds: AuthenticationState['creds'] = stored ?? initAuthCreds()

  const state: AuthenticationState = {
    creds,

    keys: {
      async get<T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
        const result: Record<string, SignalDataTypeMap[T]> = {}

        if (ids.length === 0) return result

        const keys = ids.map((id) => KEY.sessionKey(sessionId, type, id))
        const values = await redis.mget(...keys)

        for (let i = 0; i < ids.length; i++) {
          const val = values[i]
          if (val) {
            result[ids[i]!] = JSON.parse(val, bufReviver) as SignalDataTypeMap[T]
          }
        }

        return result
      },

      async set(data: {
        [category in keyof SignalDataTypeMap]?: {
          [id: string]: SignalDataTypeMap[category] | null
        }
      }): Promise<void> {
        const pipeline = redis.pipeline()

        for (const [type, values] of Object.entries(data)) {
          if (!values) continue
          for (const [id, value] of Object.entries(values)) {
            const key = KEY.sessionKey(sessionId, type, id)
            if (value === null) {
              pipeline.del(key)
            } else {
              pipeline.set(key, JSON.stringify(value, bufReplacer))
            }
          }
        }

        await pipeline.exec()
      },
    },
  }

  return {
    state,
    saveCreds: () => saveCredentials(sessionId, state.creds),
  }
}
