import { Redis } from 'ioredis'
import type { FastifyPluginAsync } from 'fastify'
import { withClient } from '../../db/client.js'
import { config } from '../../shared/config.js'
import { NotFoundError, ConflictError } from '../../shared/errors.js'
import { CHANNEL } from '../../queues/definitions.js'
import { assertScope } from '../middleware/auth.js'

const E164 = /^\+[1-9]\d{6,14}$/

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}

const sessionsRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /v1/sessions — create and start a new session ─────

  app.post('/', async (req, reply) => {
    assertScope(req, 'admin')

    const body = req.body as {
      phoneNumber?: string
      role?: 'primary' | 'backup'
      primarySessionId?: string
    }

    const phoneNumber = body.phoneNumber?.trim() ?? ''
    if (!E164.test(phoneNumber)) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'phoneNumber must be E.164 format (e.g. +2348012345678)',
      })
    }

    const role: 'primary' | 'backup' = body.role === 'backup' ? 'backup' : 'primary'

    // Single transaction — eliminates the TOCTOU race between duplicate check and insert.
    // The DB unique constraint on phone_number is the authoritative guard; we catch it here.
    let session: { id: string } | undefined
    try {
      const rows = await withClient(req.clientId, async (tx) => {
        const inserted = (await tx`
          INSERT INTO whatsapp_sessions (client_id, phone_number, role, primary_session_id, status)
          VALUES (
            ${req.clientId},
            ${phoneNumber},
            ${role},
            ${body.primarySessionId ?? null},
            'pending_qr'
          )
          RETURNING id
        `) as unknown as Array<{ id: string }>

        const sessionId: string = inserted[0]!.id

        // Create default warmup profile atomically with the session.
        // Default volume_curve and content_stages come from column defaults.
        await tx`
          INSERT INTO warmup_profiles (session_id, client_id)
          VALUES (${sessionId}, ${req.clientId})
        `

        return inserted
      })
      session = rows[0]
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`A session for ${phoneNumber} already exists`)
      }
      throw err
    }

    if (!session) throw new Error('INSERT returned no rows')

    await req.server.supervisor.startSession(session.id)

    return reply.status(201).send({
      id: session.id,
      phoneNumber,
      role,
      status: 'pending_qr',
    })
  })

  // ── GET /v1/sessions — list sessions for authenticated client ─

  app.get('/', async (req, _reply) => {
    assertScope(req, 'admin')

    // Enumerate only this client's sessions (RLS enforced)
    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        SELECT id FROM whatsapp_sessions ORDER BY created_at ASC
      `) as unknown as Array<{ id: string }>
    })

    return Promise.all(rows.map((r) => req.server.supervisor.getHealth(r.id)))
  })

  // ── GET /v1/sessions/:id — health for one session ───────────

  app.get('/:id', async (req, _reply) => {
    assertScope(req, 'admin')
    const { id } = req.params as { id: string }

    // Ownership check — empty result if not this client's session
    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        SELECT id FROM whatsapp_sessions WHERE id = ${id}
      `) as unknown as Array<{ id: string }>
    })
    if (rows.length === 0) throw new NotFoundError('Session')

    return req.server.supervisor.getHealth(id)
  })

  // ── DELETE /v1/sessions/:id — stop a session ────────────────

  app.delete('/:id', async (req, reply) => {
    assertScope(req, 'admin')
    const { id } = req.params as { id: string }

    // Ownership check
    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        SELECT id FROM whatsapp_sessions WHERE id = ${id}
      `) as unknown as Array<{ id: string }>
    })
    if (rows.length === 0) throw new NotFoundError('Session')

    await req.server.supervisor.stopSession(id)

    return reply.status(204).send()
  })

  // ── GET /v1/sessions/:id/qr (WebSocket) ────────────────────
  //
  // Streams QR code events from the session worker via Redis pub/sub.
  // Clients connect here during initial registration to display the QR.
  // The stream yields { type: 'qr', code: '...' } events until the
  // session connects, then closes.
  //
  // Authentication via ?api_key= query param (WebSocket clients cannot
  // set custom headers in all environments).

  // @fastify/websocket v8 passes SocketStream (Duplex) as the first arg.
  // Access .socket for the raw ws.WebSocket to use send/readyState/close.
  app.get('/:id/qr', { websocket: true }, (stream, req) => {
    const ws = stream.socket

    void (async () => {
      try {
        assertScope(req, 'admin')
      } catch (err) {
        ws.close(1008, err instanceof Error ? err.message : 'Unauthorized')
        return
      }

      const { id: sessionId } = req.params as { id: string }

      // Ownership check via RLS
      const rows = await withClient(req.clientId, async (tx) => {
        return (await tx`
          SELECT id FROM whatsapp_sessions WHERE id = ${sessionId}
        `) as unknown as Array<{ id: string }>
      })

      if (rows.length === 0) {
        ws.close(1008, 'Session not found')
        return
      }

      const subscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null })
      await subscriber.subscribe(CHANNEL.sessionQR(sessionId))

      subscriber.on('message', (_channel: string, message: string) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(message)
        }
      })

      const cleanup = (): void => {
        void subscriber.quit()
      }

      stream.on('close', cleanup)
      stream.on('error', cleanup)
    })()
  })
}

export default sessionsRoutes
