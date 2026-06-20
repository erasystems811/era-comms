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
    origin: '*', // ERA Comms is server-to-server infrastructure
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
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
      await v1.register(sessionRoutes, { prefix: '/sessions' })
    await v1.register(messagesRoutes, { prefix: '/messages' })
    await v1.register(webhooksRoutes, { prefix: '/webhooks' })
    },
    { prefix: '/v1' },
  )

  return app
}

export type FastifyServer = Awaited<ReturnType<typeof buildServer>>

export { config }
