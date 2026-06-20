import 'dotenv/config'
import { config } from './shared/config.js'
import { logger } from './shared/logger.js'
import { SessionSupervisor } from './sessions/supervisor.js'
import { buildServer } from './api/server.js'
import { startInboundWorker } from './workers/inbound-worker.js'
import { startWebhookWorker } from './workers/webhook-worker.js'

async function main(): Promise<void> {
  logger.info({ env: config.env }, 'ERA Comms starting')

  // Start the session supervisor — loads all non-banned sessions from
  // PostgreSQL and spawns a worker process for each one.
  const supervisor = new SessionSupervisor()
  await supervisor.start()

  // Start background workers
  const inboundWorker = startInboundWorker()
  const webhookWorker = startWebhookWorker()

  // Build and start the Fastify API server
  const app = await buildServer(supervisor)

  try {
    await app.listen({ port: config.server.port, host: config.server.host })
    logger.info({ port: config.server.port, host: config.server.host }, 'ERA Comms API ready')
  } catch (err) {
    logger.error({ err }, 'Failed to start API server')
    process.exit(1)
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down ERA Comms')

    await app.close()
    await inboundWorker.close()
    await webhookWorker.close()
    await supervisor.stop()

    logger.info('ERA Comms stopped')
    process.exit(0)
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.error({ err }, 'ERA Comms fatal startup error')
  process.exit(1)
})
