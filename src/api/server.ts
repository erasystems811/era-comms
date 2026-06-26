import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import websocketPlugin from '@fastify/websocket'
import type { ISessionSupervisor } from '../interfaces/session.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { ERAError } from '../shared/errors.js'
import { authHook } from './middleware/auth.js'
import healthRoutes from './routes/health.js'
import sessionRoutes from './routes/sessions.js'
import messagesRoutes from './routes/messages.js'
import webhooksRoutes from './routes/webhooks.js'
import adminRoutes from './routes/admin.js'
import publicRoutes from './routes/public.js'
import businessRoutes from './routes/business.js'
import metricsRoute from './routes/metrics-route.js'
import emailRoutes      from './routes/email.js'
import broadcastRoutes  from './routes/broadcasts.js'
import automationRoutes from './routes/automations.js'
import { connectAdminRoutes, connectAgentRoutes } from './routes/connect.js'
import './types.js'

export async function buildServer(supervisor: ISessionSupervisor) {
  const app = Fastify({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any, // Pino instance — compatible at runtime, types differ
    trustProxy: true,
  })

  // ── PLUGINS ────────────────────────────────────────────────

  await app.register(helmet, {
    contentSecurityPolicy: false, // API server — no HTML responses
  })

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Operator-Secret', 'X-Connect-Key', 'X-Connect-Username', 'X-Connect-Secret', 'Authorization', 'ngrok-skip-browser-warning'],
  })

  await app.register(websocketPlugin)

  // ── DECORATE ───────────────────────────────────────────────

  app.decorate('supervisor', supervisor)

  // ── ERROR HANDLER ──────────────────────────────────────────

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ERAError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      })
    }

    // Fastify schema validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: error.message,
      })
    }

    app.log.error({ err: error }, 'Unhandled error')
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    })
  })

  // ── ROUTES ─────────────────────────────────────────────────

  // Public — health check, no auth required
  await app.register(healthRoutes)

  // Authenticated — all /v1/* routes require a valid X-API-Key
  await app.register(
    async (v1) => {
      v1.addHook('preHandler', authHook)
      await v1.register(sessionRoutes,  { prefix: '/sessions' })
      await v1.register(messagesRoutes, { prefix: '/messages' })
      await v1.register(webhooksRoutes, { prefix: '/webhooks' })
    },
    { prefix: '/v1' },
  )

  // Operator admin — X-Operator-Secret auth handled inside each route handler
  // (admin.ts internally registers observability + requests as sub-plugins)
  await app.register(adminRoutes, { prefix: '/v1/admin' })

  // Public endpoints — no auth (rate-limited by nginx upstream)
  await app.register(publicRoutes, { prefix: '/v1/public' })

  // Business portal — JWT Bearer auth handled inside each route handler
  await app.register(businessRoutes, { prefix: '/v1/business' })

  // Prometheus scrape endpoint — no auth (controlled at network level)
  await app.register(metricsRoute)

  // Email module — operator routes + Postal webhook receiver
  await app.register(emailRoutes, { prefix: '/v1/admin/email' })

  // Broadcasts — WhatsApp bulk send campaigns
  await app.register(broadcastRoutes, { prefix: '/v1/admin/broadcasts' })

  // Automations — drip sequences (operator) + public trigger endpoint
  await app.register(automationRoutes, { prefix: '/v1/admin/automations' })
  // Public trigger (no auth — key is in the URL)
  await app.register(automationRoutes, { prefix: '/v1/public' })

  // Flutterwave webhook — must be public (no operator secret), Fastify-level
  await app.post('/v1/flw-webhook', async (req, reply) => {
    const secretHash = process.env['FLW_SECRET_HASH'] ?? ''
    const sig = req.headers['verif-hash'] as string | undefined
    if (!sig || sig !== secretHash) {
      return reply.status(401).send({ error: 'INVALID_SIGNATURE' })
    }
    const { adminDb } = await import('../db/client.js')
    const body = req.body as {
      event?: string
      data?: {
        id?: number; tx_ref?: string; status?: string; amount?: number; currency?: string
        customer?: { id?: number }
      }
    }
    if (body.event === 'charge.completed' && body.data?.status === 'successful') {
      const match = (body.data.tx_ref ?? '').match(/^sub_([a-f0-9-]+)_/)
      if (match?.[1]) {
        const clientId = match[1]
        await adminDb`
          UPDATE subscriptions SET status = 'active',
            flw_tx_id = ${String(body.data.id ?? '')},
            flw_customer_id = ${String(body.data.customer?.id ?? '')},
            amount = ${body.data.amount ?? null}, currency = ${body.data.currency ?? 'NGN'},
            current_period_start = NOW(), current_period_end = NOW() + INTERVAL '30 days',
            next_payment_at = NOW() + INTERVAL '30 days', updated_at = NOW()
          WHERE client_id = ${clientId}
        `
        await adminDb`UPDATE clients SET status = 'active', updated_at = NOW() WHERE id = ${clientId}`
      }
    }
    return reply.status(200).send({ received: true })
  })

  // ERA Connect — operator panel (era-hub) + agent telemetry (ERAConnect.exe)
  await app.register(connectAdminRoutes, { prefix: '/v1/admin/connect' })
  await app.register(connectAgentRoutes, { prefix: '/v1/connect' })

  return app
}

export type FastifyServer = Awaited<ReturnType<typeof buildServer>>

export { config }
