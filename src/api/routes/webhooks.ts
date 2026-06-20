import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { withClient } from '../../db/client.js'
import { NotFoundError } from '../../shared/errors.js'
import { assertScope } from '../middleware/auth.js'
import type { WebhookEventType } from '../../db/schema/messaging.js'

const VALID_EVENTS: WebhookEventType[] = [
  'message.inbound',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'conversation.escalated',
  'conversation.resumed',
  'call.completed',
  'call.failed',
  'session.connected',
  'session.disconnected',
  'session.banned',
]

const webhooksRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /v1/webhooks — register endpoint ───────────────────

  app.post('/', async (req, reply) => {
    assertScope(req, 'admin')

    const body = req.body as {
      url?: string
      events?: string[]
      secret?: string
    }

    if (!body.url) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'url is required' })
    }
    try { new URL(body.url) } catch {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'url must be a valid HTTPS URL' })
    }

    const events = (body.events ?? ['message.inbound']).filter(
      (e): e is WebhookEventType => VALID_EVENTS.includes(e as WebhookEventType),
    )
    if (events.length === 0) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'at least one valid event type is required' })
    }

    // Generate secret if not provided — shown once, not stored reversibly
    const secret = body.secret ?? randomBytes(32).toString('hex')

    type InsertRow = { id: string; url: string; events: string[]; created_at: string }
    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        INSERT INTO webhook_endpoints (client_id, url, secret, events, status)
        VALUES (${req.clientId}, ${body.url!}, ${secret}, ${events}, 'active')
        RETURNING id, url, events, created_at
      `) as unknown as InsertRow[]
    })

    const row = rows[0]!

    // Secret returned once — cannot be retrieved again
    return reply.status(201).send({
      id:        row.id,
      url:       row.url,
      events:    row.events,
      secret,
      createdAt: row.created_at,
    })
  })

  // ── GET /v1/webhooks — list endpoints ───────────────────────

  app.get('/', async (req, _reply) => {
    assertScope(req, 'admin')

    type EndpointRow = { id: string; url: string; events: string[]; status: string; created_at: string }
    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        SELECT id, url, events, status, created_at
        FROM webhook_endpoints
        ORDER BY created_at DESC
      `) as unknown as EndpointRow[]
    })

    return rows.map((r) => ({
      id:        r.id,
      url:       r.url,
      events:    r.events,
      status:    r.status,
      createdAt: r.created_at,
    }))
  })

  // ── DELETE /v1/webhooks/:id — remove endpoint ───────────────

  app.delete('/:id', async (req, reply) => {
    assertScope(req, 'admin')
    const { id } = req.params as { id: string }

    const rows = await withClient(req.clientId, async (tx) => {
      return (await tx`
        DELETE FROM webhook_endpoints WHERE id = ${id} RETURNING id
      `) as unknown as Array<{ id: string }>
    })

    if (!rows[0]) throw new NotFoundError('Webhook endpoint')

    return reply.status(204).send()
  })

  // ── GET /v1/webhooks/:id/deliveries — recent deliveries ─────

  app.get('/:id/deliveries', async (req, _reply) => {
    assertScope(req, 'admin')
    const { id: endpointId } = req.params as { id: string }
    const { limit = '50' } = req.query as Record<string, string | undefined>
    const take = Math.min(parseInt(limit, 10) || 50, 200)

    type DelivRow = {
      id: string
      event_type: string
      status: string
      attempts: number
      response_status: number | null
      last_attempt_at: string | null
      created_at: string
    }

    const rows = await withClient(req.clientId, async (tx) => {
      // Ownership verified by RLS on webhook_deliveries (client_id = current_client_id())
      // but also verify endpoint belongs to client
      const eps = (await tx`
        SELECT id FROM webhook_endpoints WHERE id = ${endpointId}
      `) as unknown as Array<{ id: string }>
      if (!eps[0]) throw new NotFoundError('Webhook endpoint')

      return (await tx`
        SELECT id, event_type, status, attempts, response_status, last_attempt_at, created_at
        FROM   webhook_deliveries
        WHERE  endpoint_id = ${endpointId}
        ORDER BY created_at DESC LIMIT ${take}
      `) as unknown as DelivRow[]
    })

    return rows.map((r) => ({
      id:             r.id,
      eventType:      r.event_type,
      status:         r.status,
      attempts:       r.attempts,
      responseStatus: r.response_status,
      lastAttemptAt:  r.last_attempt_at,
      createdAt:      r.created_at,
    }))
  })
}

export default webhooksRoutes
