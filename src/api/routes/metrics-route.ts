// ── PROMETHEUS METRICS ENDPOINT ───────────────────────────────
//
// GET /metrics — returns Prometheus text format for scraping.
// No authentication — scrape access is controlled at the network level
// (firewall, VPC, Prometheus scrape config).

import type { FastifyPluginAsync } from 'fastify'
import { registry } from '../../observability/metrics.js'

const metricsRoute: FastifyPluginAsync = async (app) => {
  app.get('/metrics', async (_req, reply) => {
    const output = await registry.metrics()
    return reply
      .header('Content-Type', registry.contentType)
      .send(output)
  })
}

export default metricsRoute
