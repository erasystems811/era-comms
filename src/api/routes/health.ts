import type { FastifyPluginAsync } from 'fastify'
import { adminDb } from '../../db/client.js'
import { redis } from '../../db/redis.js'

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    const [dbResult, redisResult] = await Promise.allSettled([
      adminDb`SELECT 1`,
      redis.ping(),
    ])

    const dbOk = dbResult.status === 'fulfilled'
    const redisOk = redisResult.status === 'fulfilled'
    const healthy = dbOk && redisOk

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      uptime: Math.round(process.uptime()),
      checks: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
    })
  })
}

export default healthRoutes
