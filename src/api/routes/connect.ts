// ── ERA CONNECT ROUTES ─────────────────────────────────────────
//
//   connectAdminRoutes  →  /v1/admin/connect/*
//     Auth: X-Operator-Secret (same secret used by all admin routes)
//     Used by: era-hub operator panel
//
//   connectAgentRoutes  →  /v1/connect/*
//     Auth: X-Connect-Key (per-instance api_key from connect_instances)
//     Used by: ERAConnect.exe running on hospital machines

import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { adminDb } from '../../db/client.js'
import { config } from '../../shared/config.js'

// ── Shared auth helpers ───────────────────────────────────────

function assertOperator(req: FastifyRequest, reply: FastifyReply): boolean {
  const raw    = req.headers['x-operator-secret']
  const secret = Array.isArray(raw) ? raw[0] : raw
  if (!secret || secret !== config.operatorSecret) {
    void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid operator secret' })
    return false
  }
  return true
}

// ── Row types ─────────────────────────────────────────────────

type InstanceRow = {
  id: string
  hospital_name: string
  hospital_id: string | null
  api_key: string
  status: string
  mode: string
  emr_engine: string | null
  version: string | null
  patients_synced: number
  care_plans_synced: number
  errors_total: number
  last_heartbeat_at: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

type ConfigRow = {
  id: string
  instance_id: string
  sync_interval_seconds: number
  paused: boolean
  notify_email: string | null
  pending_restart: boolean
  sandbox_inject: Record<string, unknown> | null
  updated_at: string
}

type EventRow = {
  id: string
  instance_id: string
  hospital_name: string | null
  event_type: string
  status: string
  message: string
  patient_mrn: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// ── Mappers ───────────────────────────────────────────────────

function mapInstance(r: InstanceRow) {
  return {
    id:               r.id,
    hospitalName:     r.hospital_name,
    hospitalId:       r.hospital_id,
    apiKey:           r.api_key,
    status:           r.status,
    mode:             r.mode,
    emrEngine:        r.emr_engine,
    version:          r.version,
    patientsSynced:   Number(r.patients_synced),
    carePlansSynced:  Number(r.care_plans_synced),
    errorsTotal:      Number(r.errors_total),
    lastHeartbeatAt:  r.last_heartbeat_at,
    lastErrorAt:      r.last_error_at,
    createdAt:        r.created_at,
    updatedAt:        r.updated_at,
  }
}

function mapConfig(r: ConfigRow) {
  return {
    id:                   r.id,
    instanceId:           r.instance_id,
    syncIntervalSeconds:  r.sync_interval_seconds,
    paused:               r.paused,
    notifyEmail:          r.notify_email,
    updatedAt:            r.updated_at,
  }
}

function mapEvent(r: EventRow) {
  return {
    id:           r.id,
    instanceId:   r.instance_id,
    hospitalName: r.hospital_name,
    eventType:    r.event_type,
    status:       r.status,
    message:      r.message,
    patientMrn:   r.patient_mrn,
    metadata:     r.metadata,
    createdAt:    r.created_at,
  }
}

// ── OPERATOR (era-hub) routes ─────────────────────────────────
// Registered at /v1/admin/connect

export const connectAdminRoutes: FastifyPluginAsync = async (app) => {

  // GET /instances
  app.get('/instances', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const rows = await adminDb<InstanceRow[]>`
      SELECT * FROM connect_instances
      ORDER BY last_heartbeat_at DESC NULLS LAST, created_at DESC
    `
    return rows.map(mapInstance)
  })

  // POST /instances
  app.post('/instances', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const body = req.body as {
      hospitalName: string
      hospitalId?: string
      mode?: string
      emrEngine?: string
    }

    if (!body?.hospitalName?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'hospitalName is required' })
    }

    const apiKey = randomBytes(32).toString('hex')

    const [instance] = await adminDb<InstanceRow[]>`
      INSERT INTO connect_instances (hospital_name, hospital_id, api_key, mode, emr_engine)
      VALUES (
        ${body.hospitalName.trim()},
        ${body.hospitalId ?? null},
        ${apiKey},
        ${body.mode ?? 'database'},
        ${body.emrEngine ?? null}
      )
      RETURNING *
    `

    await adminDb`INSERT INTO connect_configs (instance_id) VALUES (${instance!.id})`

    return reply.status(201).send(mapInstance(instance!))
  })

  // GET /instances/:id
  app.get('/instances/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }

    const [instance] = await adminDb<InstanceRow[]>`
      SELECT * FROM connect_instances WHERE id = ${id}
    `
    if (!instance) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Instance not found' })

    const [cfg] = await adminDb<ConfigRow[]>`
      SELECT * FROM connect_configs WHERE instance_id = ${id}
    `

    return { ...mapInstance(instance), config: cfg ? mapConfig(cfg) : null }
  })

  // DELETE /instances/:id
  app.delete('/instances/:id', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const result = await adminDb`DELETE FROM connect_instances WHERE id = ${id}`
    if (result.count === 0) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Instance not found' })
    }
    return reply.status(204).send()
  })

  // PATCH /instances/:id/config
  app.patch('/instances/:id/config', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const { id } = req.params as { id: string }
    const body = req.body as {
      syncIntervalSeconds?: number
      paused?: boolean
      notifyEmail?: string | null
    }

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.syncIntervalSeconds !== undefined) updates.sync_interval_seconds = body.syncIntervalSeconds
    if (body.paused              !== undefined) updates.paused               = body.paused
    if ('notifyEmail'            in body)       updates.notify_email         = body.notifyEmail ?? null

    if (Object.keys(updates).length === 1) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'No fields to update' })
    }

    const [cfg] = await adminDb<ConfigRow[]>`
      UPDATE connect_configs
      SET ${adminDb(updates)}
      WHERE instance_id = ${id}
      RETURNING *
    `
    if (!cfg) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Instance not found' })

    return mapConfig(cfg)
  })

  // GET /events
  app.get('/events', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const q = req.query as {
      instanceId?:  string
      eventType?:   string
      status?:      string
      from?:        string
      to?:          string
      hideRoutine?: string
      limit?:       string
      offset?:      string
    }

    const limit       = Math.min(parseInt(q.limit  ?? '100', 10), 500)
    const offset      = parseInt(q.offset ?? '0', 10)
    const hideRoutine = q.hideRoutine === 'true'

    // Routine events: heartbeat and config polls — excluded by default
    const ROUTINE_TYPES = ['heartbeat', 'config_fetched', 'config_updated']

    const rows = await adminDb<EventRow[]>`
      SELECT e.*, i.hospital_name
      FROM   connect_events e
      JOIN   connect_instances i ON i.id = e.instance_id
      WHERE  TRUE
        ${q.instanceId ? adminDb`AND e.instance_id = ${q.instanceId}` : adminDb``}
        ${q.eventType  ? adminDb`AND e.event_type  = ${q.eventType}`  : adminDb``}
        ${q.status     ? adminDb`AND e.status      = ${q.status}`     : adminDb``}
        ${q.from ? adminDb`AND e.created_at >= ${new Date(q.from)}` : adminDb``}
        ${q.to   ? adminDb`AND e.created_at <= ${new Date(q.to)}`   : adminDb``}
        ${hideRoutine  ? adminDb`AND e.event_type NOT IN ${adminDb(ROUTINE_TYPES)}` : adminDb``}
      ORDER BY e.created_at DESC
      LIMIT  ${limit} OFFSET ${offset}
    `

    const [{ total }] = await adminDb<[{ total: string }]>`
      SELECT COUNT(*) AS total
      FROM   connect_events e
      WHERE  TRUE
        ${q.instanceId ? adminDb`AND e.instance_id = ${q.instanceId}` : adminDb``}
        ${q.eventType  ? adminDb`AND e.event_type  = ${q.eventType}`  : adminDb``}
        ${q.status     ? adminDb`AND e.status      = ${q.status}`     : adminDb``}
        ${q.from ? adminDb`AND e.created_at >= ${new Date(q.from)}` : adminDb``}
        ${q.to   ? adminDb`AND e.created_at <= ${new Date(q.to)}`   : adminDb``}
        ${hideRoutine  ? adminDb`AND e.event_type NOT IN ${adminDb(ROUTINE_TYPES)}` : adminDb``}
    `

    return { events: rows.map(mapEvent), total: parseInt(total, 10), limit, offset }
  })

  // GET /release
  app.get('/release', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const [row] = await adminDb<[{ version: string; download_url: string; updated_at: string }]>`
      SELECT version, download_url, updated_at FROM connect_release WHERE id = 1
    `
    if (!row) return { version: '0.0.0', downloadUrl: '', updatedAt: null }
    return { version: row.version, downloadUrl: row.download_url, updatedAt: row.updated_at }
  })

  // PATCH /release
  app.patch('/release', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const body = req.body as { version?: string; downloadUrl?: string }
    if (!body?.version?.trim() || !body?.downloadUrl?.trim()) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'version and downloadUrl are required' })
    }
    const [row] = await adminDb<[{ version: string; download_url: string; updated_at: string }]>`
      UPDATE connect_release
      SET version = ${body.version.trim()}, download_url = ${body.downloadUrl.trim()}, updated_at = NOW()
      WHERE id = 1
      RETURNING version, download_url, updated_at
    `
    return { version: row!.version, downloadUrl: row!.download_url, updatedAt: row!.updated_at }
  })

  // POST /instances/:id/sandbox/inject-patient
  app.post('/instances/:id/sandbox/inject-patient', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    const body = req.body as {
      firstName?: string
      lastName?: string
      phone?: string
      dateOfBirth?: string
    }
    const payload = {
      type:         'patient',
      firstName:    (body.firstName  ?? 'Test').trim(),
      lastName:     (body.lastName   ?? 'Patient').trim(),
      phone:        (body.phone      ?? '').trim(),
      dateOfBirth:  body.dateOfBirth ?? null,
    }
    const result = await adminDb`
      UPDATE connect_configs SET sandbox_inject = ${adminDb.json(payload)}, updated_at = NOW()
      WHERE instance_id = ${id}
    `
    if (result.count === 0) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Instance not found' })
    }
    return { ok: true }
  })

  // POST /instances/:id/sandbox/inject-treatment
  app.post('/instances/:id/sandbox/inject-treatment', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    const body = req.body as {
      medication?: string
      dosage?: string
      timing?: string
      duration?: string
      doctorName?: string
    }
    const payload = {
      type:       'treatment',
      medication: (body.medication ?? 'Paracetamol').trim(),
      dosage:     (body.dosage     ?? '500mg').trim(),
      timing:     (body.timing     ?? 'Twice daily').trim(),
      duration:   (body.duration   ?? '3 days').trim(),
      doctorName: (body.doctorName ?? 'Dr. Test').trim(),
    }
    const result = await adminDb`
      UPDATE connect_configs SET sandbox_inject = ${adminDb.json(payload)}, updated_at = NOW()
      WHERE instance_id = ${id}
    `
    if (result.count === 0) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Instance not found' })
    }
    return { ok: true }
  })

  // POST /instances/:id/restart
  app.post('/instances/:id/restart', async (req, reply) => {
    if (!assertOperator(req, reply)) return
    const { id } = req.params as { id: string }
    const result = await adminDb`
      UPDATE connect_configs SET pending_restart = TRUE, updated_at = NOW()
      WHERE instance_id = ${id}
    `
    if (result.count === 0) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Instance not found' })
    }
    await adminDb`
      INSERT INTO connect_events (instance_id, event_type, message)
      VALUES (${id}, 'restart', 'Remote restart triggered from era-hub')
    `
    return reply.status(204).send()
  })

  // GET /stats
  app.get('/stats', async (req, reply) => {
    if (!assertOperator(req, reply)) return

    const [counts] = await adminDb<[{
      total: string; online: string; offline: string; error: string
    }]>`
      SELECT
        COUNT(*)                                    AS total,
        COUNT(*) FILTER (WHERE status = 'online')   AS online,
        COUNT(*) FILTER (WHERE status = 'offline')  AS offline,
        COUNT(*) FILTER (WHERE status = 'error')    AS error
      FROM connect_instances
    `

    const [totals] = await adminDb<[{
      patients_synced: string; care_plans_synced: string; errors_total: string
    }]>`
      SELECT
        COALESCE(SUM(patients_synced),   0) AS patients_synced,
        COALESCE(SUM(care_plans_synced), 0) AS care_plans_synced,
        COALESCE(SUM(errors_total),      0) AS errors_total
      FROM connect_instances
    `

    return {
      instances: {
        total:   parseInt(counts!.total,   10),
        online:  parseInt(counts!.online,  10),
        offline: parseInt(counts!.offline, 10),
        error:   parseInt(counts!.error,   10),
      },
      totals: {
        patientsSynced:  parseInt(totals!.patients_synced,   10),
        carePlansSynced: parseInt(totals!.care_plans_synced, 10),
        errorsTotal:     parseInt(totals!.errors_total,      10),
      },
    }
  })
}

// ── AGENT (ERAConnect.exe) routes ─────────────────────────────
// Registered at /v1/connect
//
// Auth: X-Connect-Username (era_username) + X-Connect-Secret (shared secret).
// No per-hospital setup required — instances are auto-created on first contact.

export const connectAgentRoutes: FastifyPluginAsync = async (app) => {

  async function resolveOrCreateInstance(req: FastifyRequest, reply: FastifyReply) {
    const rawUser   = req.headers['x-connect-username']
    const rawSecret = req.headers['x-connect-secret']
    const username  = Array.isArray(rawUser)   ? rawUser[0]   : rawUser
    const secret    = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret

    if (!secret || secret !== config.connectSharedSecret) {
      void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid connect secret' })
      return null
    }
    if (!username) {
      void reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Missing X-Connect-Username' })
      return null
    }

    // Look up by hospital_id (== era_username set at auto-registration)
    let [instance] = await adminDb<InstanceRow[]>`
      SELECT * FROM connect_instances WHERE hospital_id = ${username}
    `

    // Auto-create on first contact — no manual setup needed
    if (!instance) {
      const { randomBytes } = await import('node:crypto')
      const apiKey = randomBytes(32).toString('hex')

      // ON CONFLICT handles the rare case of two startup events racing.
      // Must include the partial-index predicate to match migration 006.
      const [created] = await adminDb<InstanceRow[]>`
        INSERT INTO connect_instances (hospital_name, hospital_id, api_key)
        VALUES (${username}, ${username}, ${apiKey})
        ON CONFLICT (hospital_id) WHERE hospital_id IS NOT NULL DO UPDATE
          SET updated_at = NOW()
        RETURNING *
      `
      instance = created!

      await adminDb`
        INSERT INTO connect_configs (instance_id)
        VALUES (${instance.id})
        ON CONFLICT DO NOTHING
      `
    }

    return instance
  }

  // GET /version — no auth, exe calls this before it has an instance
  app.get('/version', async (_req, reply) => {
    const [row] = await adminDb<[{ version: string; download_url: string }]>`
      SELECT version, download_url FROM connect_release WHERE id = 1
    `
    if (!row || !row.download_url) {
      return reply.status(204).send()
    }
    return { version: row.version, downloadUrl: row.download_url }
  })

  // POST /telemetry
  app.post('/telemetry', async (req, reply) => {
    const instance = await resolveOrCreateInstance(req, reply)
    if (!instance) return

    const body = req.body as {
      version?:    string
      mode?:       string
      emr_engine?: string
      events: Array<{
        event_type:   string
        status?:      string
        message?:     string
        patient_mrn?: string
        metadata?:    Record<string, unknown>
      }>
    }

    if (!Array.isArray(body?.events) || body.events.length === 0) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'events array is required' })
    }

    let patientDelta  = 0
    let carePlanDelta = 0
    let errorDelta    = 0
    let hasError      = false
    let lastErrorAt: string | null = instance.last_error_at

    for (const ev of body.events) {
      if (ev.event_type === 'patient_synced')   patientDelta++
      if (ev.event_type === 'care_plan_synced') carePlanDelta++
      if (ev.status === 'error' || ev.event_type === 'sync_error') {
        errorDelta++
        hasError = true
        lastErrorAt = new Date().toISOString()
      }
    }

    const eventRows = body.events.map(ev => ({
      instance_id: instance.id,
      event_type:  ev.event_type,
      status:      ev.status      ?? 'ok',
      message:     ev.message     ?? '',
      patient_mrn: ev.patient_mrn ?? null,
      metadata:    JSON.stringify(ev.metadata ?? {}),
    }))

    await adminDb`INSERT INTO connect_events ${adminDb(eventRows)}`

    // Build update — avoid SQL fragments in an object; use conditional updates
    await adminDb`
      UPDATE connect_instances SET
        status            = ${hasError ? 'error' : 'online'},
        last_heartbeat_at = NOW(),
        updated_at        = NOW(),
        version           = COALESCE(${body.version ?? null}, version),
        mode              = COALESCE(${body.mode ?? null}, mode),
        emr_engine        = COALESCE(${body.emr_engine ?? null}, emr_engine),
        patients_synced   = patients_synced   + ${patientDelta},
        care_plans_synced = care_plans_synced + ${carePlanDelta},
        errors_total      = errors_total      + ${errorDelta},
        last_error_at     = CASE WHEN ${hasError} THEN NOW() ELSE last_error_at END
      WHERE id = ${instance.id}
    `

    return reply.status(204).send()
  })

  // GET /config
  app.get('/config', async (req, reply) => {
    const instance = await resolveOrCreateInstance(req, reply)
    if (!instance) return

    await adminDb`
      UPDATE connect_instances
      SET last_heartbeat_at = NOW(), status = 'online', updated_at = NOW()
      WHERE id = ${instance.id}
    `

    const [cfg] = await adminDb<ConfigRow[]>`
      SELECT * FROM connect_configs WHERE instance_id = ${instance.id}
    `

    if (!cfg) return { syncIntervalSeconds: 30, paused: false, pendingRestart: false, sandboxInject: null }

    // One-shot delivery: clear pending_restart and sandbox_inject immediately
    // so they don't fire again on the next config poll.
    if (cfg.pending_restart || cfg.sandbox_inject) {
      await adminDb`
        UPDATE connect_configs
        SET
          pending_restart = FALSE,
          sandbox_inject  = NULL
        WHERE instance_id = ${instance.id}
      `
    }

    return {
      ...mapConfig(cfg),
      pendingRestart: !!cfg.pending_restart,
      sandboxInject:  cfg.sandbox_inject ?? null,
    }
  })
}
