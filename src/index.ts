import 'dotenv/config'
import { Queue } from 'bullmq'
import { config } from './shared/config.js'
import { logger } from './shared/logger.js'
import { SessionSupervisor } from './sessions/supervisor.js'
import { buildServer } from './api/server.js'
import { startInboundWorker } from './workers/inbound-worker.js'
import { startWebhookWorker } from './workers/webhook-worker.js'
import { startAIWorker } from './workers/ai-worker.js'
import { startAnalyticsWorker } from './workers/analytics-worker.js'
import { CallSupervisor } from './voice/call-supervisor.js'
import { queueDepth } from './observability/metrics.js'
import { QUEUE } from './queues/definitions.js'

async function main(): Promise<void> {
  logger.info({ env: config.env }, 'ERA Comms starting')

  // Start the session supervisor — loads all non-banned sessions from
  // PostgreSQL and spawns a worker process for each one.
  const supervisor = new SessionSupervisor()
  await supervisor.start()

  // Start background workers
  const inboundWorker   = startInboundWorker()
  const webhookWorker   = startWebhookWorker()
  const aiWorker        = startAIWorker()
  const analyticsWorker = startAnalyticsWorker()

  // Start voice subsystem — connects to FreeSWITCH ESL
  const callSupervisor = new CallSupervisor()
  await callSupervisor.start()

  // Build and start the Fastify API server
  const app = await buildServer(supervisor)

  try {
    await app.listen({ port: config.server.port, host: config.server.host })
    logger.info({ port: config.server.port, host: config.server.host }, 'ERA Comms API ready')
  } catch (err) {
    logger.error({ err }, 'Failed to start API server')
    process.exit(1)
  }

  // Queue depth poller — updates Prometheus gauges every 30 s
  const polledQueues = [
    new Queue(QUEUE.inbound,   { connection: { url: config.redis.url } }),
    new Queue(QUEUE.webhooks,  { connection: { url: config.redis.url } }),
    new Queue(QUEUE.ai,        { connection: { url: config.redis.url } }),
    new Queue(QUEUE.analytics, { connection: { url: config.redis.url } }),
  ]
  const pollDepths = async (): Promise<void> => {
    for (const q of polledQueues) {
      try {
        queueDepth.set({ queue: q.name }, await q.getWaitingCount())
      } catch { /* transient Redis hiccup — skip */ }
    }
  }
  void pollDepths()
  const depthPoller = setInterval(() => void pollDepths(), 30_000)

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down ERA Comms')

    clearInterval(depthPoller)
    await Promise.all(polledQueues.map((q) => q.close()))
    callSupervisor.stop()
    await app.close()
    await inboundWorker.close()
    await webhookWorker.close()
    await aiWorker.close()
    await analyticsWorker.close()
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
