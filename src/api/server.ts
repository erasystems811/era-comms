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
import accountRoutes             from './routes/account.js'
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
      await v1.register(accountRoutes,              { prefix: '/me' })
      await v1.register(sessionRoutes,              { prefix: '/sessions' })
      await v1.register(messagesRoutes,  { prefix: '/messages' })
      await v1.register(webhooksRoutes,  { prefix: '/webhooks' })
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

  // Email public routes — unsubscribe (no auth)
  await app.get('/v1/email/unsubscribe', async (req, reply) => {
    const { adminDb: db } = await import('../db/client.js')
    const { sid, eid }    = req.query as { sid?: string; eid?: string }

    if (sid) {
      const [send] = await db<{ email: string; client_id: string }[]>`
        SELECT email, client_id FROM email_sends WHERE id = ${sid} LIMIT 1
      `
      if (send) {
        await db`INSERT INTO email_suppressions (email, reason, client_id) VALUES (${send.email}, 'unsubscribe', ${send.client_id}) ON CONFLICT DO NOTHING`
        await db`UPDATE email_sends SET unsubscribed_at = NOW() WHERE id = ${sid}`
      }
    }

    if (eid) {
      const [enrollment] = await db<{ email: string; client_id: string }[]>`
        SELECT email, client_id FROM email_automation_enrollments WHERE id = ${eid} LIMIT 1
      `
      if (enrollment) {
        await db`INSERT INTO email_suppressions (email, reason, client_id) VALUES (${enrollment.email}, 'unsubscribe', ${enrollment.client_id}) ON CONFLICT DO NOTHING`
        await db`UPDATE email_automation_enrollments SET status = 'unsubscribed', updated_at = NOW() WHERE id = ${eid}`
      }
    }

    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}.card{max-width:360px;text-align:center;padding:40px 32px}h1{font-size:20px;margin:0 0 8px;color:#f8fafc}p{font-size:14px;color:#94a3b8;margin:0;line-height:1.6}</style>
</head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">✓</div>
<h1>You've been unsubscribed</h1><p>You'll no longer receive these emails. If this was a mistake, please contact the sender directly.</p>
</div></body></html>`)
  })

  // Email automation public trigger (key in URL, no operator auth)
  await app.post('/v1/public/email-trigger/:key', async (req, reply) => {
    const { adminDb: db } = await import('../db/client.js')
    const { key }         = req.params as { key: string }
    const { email, firstName, lastName } = req.body as { email?: string; firstName?: string; lastName?: string }

    if (!email?.includes('@')) return reply.status(400).send({ error: 'Valid email required' })

    const [flow] = await db<{ id: string; client_id: string; status: string }[]>`
      SELECT id, client_id, status FROM email_automation_flows WHERE trigger_key = ${key}
    `
    if (!flow || flow.status !== 'active') return reply.status(404).send({ error: 'Trigger not found' })

    const existing = await db<{ status: string }[]>`
      SELECT status FROM email_automation_enrollments WHERE flow_id = ${flow.id} AND email = ${email.toLowerCase()}
    `
    if (existing[0]?.status === 'active') return reply.send({ enrolled: false, reason: 'already_active' })

    await db`
      INSERT INTO email_automation_enrollments (flow_id, client_id, email, first_name, last_name)
      VALUES (${flow.id}, ${flow.client_id}, ${email.toLowerCase()}, ${firstName ?? null}, ${lastName ?? null})
      ON CONFLICT (flow_id, email)
      DO UPDATE SET status = 'active', current_step = 0, next_step_at = NOW(),
                    first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, updated_at = NOW()
    `
    await db`UPDATE email_automation_flows SET total_enrolled = total_enrolled + 1, updated_at = NOW() WHERE id = ${flow.id}`
    return reply.send({ enrolled: true })
  })

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
