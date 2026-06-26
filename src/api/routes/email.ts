// ── EMAIL MODULE ADMIN ROUTES ─────────────────────────────────
//
// All routes require X-Operator-Secret except the Postal webhook receiver
// and the public unsubscribe endpoint.
// Prefix: /v1/admin/email (registered in server.ts)

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { createHmac }       from 'node:crypto'
import { adminDb }          from '../../db/client.js'
import { config }           from '../../shared/config.js'
import { launchCampaign, handlePostalEvent } from '../../services/email-campaigns.js'
import { postalPing, postalDnsRecords }     from '../../services/postal.js'
import { randomBytes }      from 'node:crypto'

// ── Auth guard ─────────────────────────────────────────────────

function assertOp(req: FastifyRequest, reply: FastifyReply): boolean {
  const raw = req.headers['x-operator-secret']
  const s   = Array.isArray(raw) ? raw[0] : raw
  if (!s || s !== config.operatorSecret) {
    void reply.status(401).send({ error: 'UNAUTHORIZED' })
    return false
  }
  return true
}

// ── Row types ──────────────────────────────────────────────────

type DomainRow = {
  id: string; client_id: string; domain: string
  spf_verified: boolean; dkim_verified: boolean
  dmarc_verified: boolean; mx_verified: boolean
  dkim_public_key: string | null; postal_server_id: string | null
  verified_at: string | null; created_at: string
  client_name: string
}

type TemplateRow = {
  id: string; client_id: string; client_name: string
  name: string; subject: string; html_body: string
  created_at: string; updated_at: string
}

type CampaignRow = {
  id: string; client_id: string; client_name: string; name: string
  template_id: string; template_name: string
  list_id: string; list_name: string
  status: string; scheduled_at: string | null
  started_at: string | null; completed_at: string | null
  total_recipients: number; total_sent: number
  total_delivered: number; total_clicked: number
  total_bounced: number; total_complained: number
  created_at: string
}

type ListRow = {
  id: string; client_id: string; client_name: string
  name: string; created_at: string; contact_count: string
}

type SuppressionRow = {
  id: string; email: string; reason: string
  client_id: string | null; client_name: string | null; created_at: string
}

// ── Plugin ─────────────────────────────────────────────────────

const emailRoutes: FastifyPluginAsync = async (app) => {

  // ── OVERVIEW ───────────────────────────────────────────────

  app.get('/overview', async (req, reply) => {
    if (!assertOp(req, reply)) return

    const [stats] = await adminDb<{
      total_sent_today: string
      total_sent_30d:   string
      total_delivered:  string
      total_clicked:    string
      total_bounced:    string
    }[]>`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')     AS total_sent_today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')    AS total_sent_30d,
        COUNT(*) FILTER (WHERE status = 'delivered')                         AS total_delivered,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)                       AS total_clicked,
        COUNT(*) FILTER (WHERE status = 'bounced')                           AS total_bounced
      FROM email_sends
    `

    const postalOk = await postalPing()

    reply.send({
      postalConnected:   postalOk,
      sentToday:         Number(stats?.total_sent_today ?? 0),
      sent30d:           Number(stats?.total_sent_30d   ?? 0),
      deliveryRate:      calcRate(stats?.total_delivered, stats?.total_sent_30d),
      clickRate:         calcRate(stats?.total_clicked,   stats?.total_delivered),
      bounceRate:        calcRate(stats?.total_bounced,   stats?.total_sent_30d),
    })
  })

  // ── DOMAINS ────────────────────────────────────────────────

  app.get('/domains', async (req, reply) => {
    if (!assertOp(req, reply)) return

    const rows = await adminDb<DomainRow[]>`
      SELECT d.*, c.name AS client_name
      FROM email_domains d
      JOIN clients c ON c.id = d.client_id
      ORDER BY d.created_at DESC
    `
    reply.send(rows.map(mapDomain))
  })

  app.post('/domains', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId, domain } = req.body as { clientId: string; domain: string }

    if (!clientId || !domain) return reply.status(400).send({ error: 'clientId and domain required' })

    const [row] = await adminDb<DomainRow[]>`
      INSERT INTO email_domains (client_id, domain)
      VALUES (${clientId}, ${domain.toLowerCase().trim()})
      ON CONFLICT (client_id, domain) DO NOTHING
      RETURNING *, (SELECT name FROM clients WHERE id = client_id) AS client_name
    `
    if (!row) return reply.status(409).send({ error: 'Domain already exists for this client' })
    reply.status(201).send(mapDomain(row))
  })

  app.get('/domains/:id/dns', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [row] = await adminDb<{ domain: string; dkim_public_key: string | null }[]>`
      SELECT domain, dkim_public_key FROM email_domains WHERE id = ${id}
    `
    if (!row) return reply.status(404).send({ error: 'Domain not found' })

    reply.send(postalDnsRecords(row.domain, row.dkim_public_key))
  })

  // PATCH /domains/:id — update DKIM public key
  app.patch('/domains/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id }            = req.params as { id: string }
    const { dkimPublicKey } = req.body as { dkimPublicKey?: string }

    const [row] = await adminDb<DomainRow[]>`
      UPDATE email_domains
      SET dkim_public_key = ${dkimPublicKey ?? null}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *, (SELECT name FROM clients WHERE id = client_id) AS client_name
    `
    if (!row) return reply.status(404).send({ error: 'Domain not found' })
    reply.send(mapDomain(row))
  })

  // POST /domains/:id/verify — try Postal API; fall back to manual flag update
  app.post('/domains/:id/verify', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [domainRow] = await adminDb<{ domain: string; dkim_public_key: string | null }[]>`
      SELECT domain, dkim_public_key FROM email_domains WHERE id = ${id}
    `
    if (!domainRow) return reply.status(404).send({ error: 'Domain not found' })

    // Attempt real Postal verification if configured
    if (config.email.postalApiKey && config.email.postalServerUrl) {
      try {
        const res = await fetch(`${config.email.postalServerUrl}/api/v1/domains/check`, {
          method: 'POST',
          headers: {
            'X-Server-API-Key': config.email.postalApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: domainRow.domain }),
        })
        if (res.ok) {
          const data = await res.json() as {
            data?: { spf?: { valid: boolean }; dkim?: { valid: boolean }; mx?: { valid: boolean } }
          }
          const d = data.data
          await adminDb`
            UPDATE email_domains
            SET spf_verified   = ${d?.spf?.valid  ?? false},
                dkim_verified  = ${d?.dkim?.valid ?? false},
                mx_verified    = ${d?.mx?.valid   ?? false},
                dmarc_verified = FALSE,
                verified_at    = CASE WHEN ${d?.spf?.valid ?? false} AND ${d?.dkim?.valid ?? false} THEN NOW() ELSE verified_at END,
                updated_at     = NOW()
            WHERE id = ${id}
          `
          return reply.send({ checked: true, spf: d?.spf?.valid, dkim: d?.dkim?.valid, mx: d?.mx?.valid })
        }
      } catch { /* fall through to manual notice */ }
    }

    reply.send({ queued: true, message: 'Add the DNS records at your registrar, then click Verify again. Postal checks automatically every few minutes.' })
  })

  // POST /domains/:id/mark-verified — operator manually confirms domain is set up
  app.post('/domains/:id/mark-verified', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    await adminDb`
      UPDATE email_domains
      SET spf_verified   = TRUE,
          dkim_verified  = TRUE,
          dmarc_verified = TRUE,
          mx_verified    = TRUE,
          verified_at    = NOW(),
          updated_at     = NOW()
      WHERE id = ${id}
    `
    reply.send({ verified: true })
  })

  app.delete('/domains/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    await adminDb`DELETE FROM email_domains WHERE id = ${id}`
    reply.status(204).send()
  })

  // ── TEMPLATES ─────────────────────────────────────────────

  app.get('/templates', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId } = req.query as { clientId?: string }

    const rows = clientId
      ? await adminDb<TemplateRow[]>`
          SELECT t.*, c.name AS client_name
          FROM email_templates t JOIN clients c ON c.id = t.client_id
          WHERE t.client_id = ${clientId}
          ORDER BY t.updated_at DESC`
      : await adminDb<TemplateRow[]>`
          SELECT t.*, c.name AS client_name
          FROM email_templates t JOIN clients c ON c.id = t.client_id
          ORDER BY t.updated_at DESC`

    reply.send(rows.map(mapTemplate))
  })

  app.post('/templates', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId, name, subject, htmlBody } = req.body as {
      clientId: string; name: string; subject: string; htmlBody: string
    }
    if (!clientId || !name || !subject || !htmlBody)
      return reply.status(400).send({ error: 'clientId, name, subject, htmlBody required' })

    const [row] = await adminDb<TemplateRow[]>`
      INSERT INTO email_templates (client_id, name, subject, html_body)
      VALUES (${clientId}, ${name}, ${subject}, ${htmlBody})
      RETURNING *, (SELECT name FROM clients WHERE id = client_id) AS client_name
    `
    reply.status(201).send(mapTemplate(row!))
  })

  app.get('/templates/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [row] = await adminDb<TemplateRow[]>`
      SELECT t.*, c.name AS client_name
      FROM email_templates t JOIN clients c ON c.id = t.client_id
      WHERE t.id = ${id}
    `
    if (!row) return reply.status(404).send({ error: 'Template not found' })
    reply.send(mapTemplate(row))
  })

  app.put('/templates/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }
    const { name, subject, htmlBody } = req.body as {
      name?: string; subject?: string; htmlBody?: string
    }

    const [row] = await adminDb<TemplateRow[]>`
      UPDATE email_templates
      SET
        name       = COALESCE(${name ?? null}, name),
        subject    = COALESCE(${subject ?? null}, subject),
        html_body  = COALESCE(${htmlBody ?? null}, html_body),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *, (SELECT name FROM clients WHERE id = client_id) AS client_name
    `
    if (!row) return reply.status(404).send({ error: 'Template not found' })
    reply.send(mapTemplate(row))
  })

  app.delete('/templates/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM email_templates WHERE id = ${id}`
    reply.status(204).send()
  })

  // ── CAMPAIGNS ─────────────────────────────────────────────

  app.get('/campaigns', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId, status } = req.query as { clientId?: string; status?: string }

    const rows = await adminDb<CampaignRow[]>`
      SELECT
        camp.*,
        c.name   AS client_name,
        t.name   AS template_name,
        l.name   AS list_name
      FROM email_campaigns camp
      JOIN clients         c ON c.id = camp.client_id
      JOIN email_templates t ON t.id = camp.template_id
      JOIN email_contact_lists l ON l.id = camp.list_id
      WHERE (${clientId ?? null}::uuid IS NULL OR camp.client_id = ${clientId ?? null})
        AND (${status ?? null}::text IS NULL OR camp.status = ${status ?? null})
      ORDER BY camp.created_at DESC
      LIMIT 200
    `
    reply.send(rows.map(mapCampaign))
  })

  app.post('/campaigns', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId, name, templateId, listId, domainId, fromName, fromEmail, scheduledAt } = req.body as {
      clientId: string; name: string; templateId: string
      listId: string; domainId: string; fromName: string
      fromEmail: string; scheduledAt?: string
    }

    const [row] = await adminDb<CampaignRow[]>`
      INSERT INTO email_campaigns
        (client_id, name, template_id, list_id, domain_id, from_name, from_email, status, scheduled_at)
      VALUES
        (${clientId}, ${name}, ${templateId}, ${listId}, ${domainId},
         ${fromName}, ${fromEmail},
         ${scheduledAt ? 'scheduled' : 'draft'},
         ${scheduledAt ?? null})
      RETURNING
        *,
        (SELECT name FROM clients WHERE id = client_id)           AS client_name,
        (SELECT name FROM email_templates WHERE id = template_id) AS template_name,
        (SELECT name FROM email_contact_lists WHERE id = list_id) AS list_name
    `
    reply.status(201).send(mapCampaign(row!))
  })

  app.get('/campaigns/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [row] = await adminDb<CampaignRow[]>`
      SELECT camp.*, c.name AS client_name, t.name AS template_name, l.name AS list_name
      FROM email_campaigns camp
      JOIN clients c ON c.id = camp.client_id
      JOIN email_templates t ON t.id = camp.template_id
      JOIN email_contact_lists l ON l.id = camp.list_id
      WHERE camp.id = ${id}
    `
    if (!row) return reply.status(404).send({ error: 'Campaign not found' })
    reply.send(mapCampaign(row))
  })

  // POST /campaigns/:id/send — launch immediately (or confirm scheduled)
  app.post('/campaigns/:id/send', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [camp] = await adminDb<{ status: string }[]>`
      SELECT status FROM email_campaigns WHERE id = ${id}
    `
    if (!camp) return reply.status(404).send({ error: 'Campaign not found' })
    if (camp.status === 'sending' || camp.status === 'sent')
      return reply.status(409).send({ error: `Campaign is already ${camp.status}` })

    const { queued } = await launchCampaign(id)
    reply.send({ launched: true, queued })
  })

  // POST /campaigns/:id/cancel
  app.post('/campaigns/:id/cancel', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    await adminDb`
      UPDATE email_campaigns
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${id} AND status IN ('draft', 'scheduled')
    `
    reply.send({ cancelled: true })
  })

  // ── CONTACT LISTS ─────────────────────────────────────────

  app.get('/contacts/lists', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId } = req.query as { clientId?: string }

    const rows = await adminDb<ListRow[]>`
      SELECT l.*, c.name AS client_name,
             COUNT(ec.id)::text AS contact_count
      FROM email_contact_lists l
      JOIN clients c ON c.id = l.client_id
      LEFT JOIN email_contacts ec ON ec.list_id = l.id
      WHERE (${clientId ?? null}::uuid IS NULL OR l.client_id = ${clientId ?? null})
      GROUP BY l.id, c.name
      ORDER BY l.created_at DESC
    `
    reply.send(rows.map(r => ({
      id:           r.id,
      clientId:     r.client_id,
      clientName:   r.client_name,
      name:         r.name,
      contactCount: Number(r.contact_count),
      createdAt:    r.created_at,
    })))
  })

  app.post('/contacts/lists', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId, name } = req.body as { clientId: string; name: string }
    if (!clientId || !name) return reply.status(400).send({ error: 'clientId and name required' })

    const [row] = await adminDb<{ id: string; name: string; created_at: string }[]>`
      INSERT INTO email_contact_lists (client_id, name) VALUES (${clientId}, ${name})
      RETURNING id, name, created_at
    `
    reply.status(201).send(row)
  })

  app.delete('/contacts/lists/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM email_contact_lists WHERE id = ${id}`
    reply.status(204).send()
  })

  // POST /contacts/lists/:id/import — bulk import from JSON array
  // Accepts: [{ email, firstName?, lastName? }, ...]
  app.post('/contacts/lists/:id/import', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [list] = await adminDb<{ client_id: string }[]>`
      SELECT client_id FROM email_contact_lists WHERE id = ${id}
    `
    if (!list) return reply.status(404).send({ error: 'List not found' })

    const contacts = (req.body as { email: string; firstName?: string; lastName?: string }[])
    if (!Array.isArray(contacts) || contacts.length === 0)
      return reply.status(400).send({ error: 'Provide array of contacts' })

    let imported = 0
    for (const c of contacts) {
      if (!c.email?.includes('@')) continue
      await adminDb`
        INSERT INTO email_contacts (list_id, client_id, email, first_name, last_name)
        VALUES (${id}, ${list.client_id}, ${c.email.toLowerCase()}, ${c.firstName ?? null}, ${c.lastName ?? null})
        ON CONFLICT (list_id, email) DO NOTHING
      `
      imported++
    }

    reply.send({ imported })
  })

  // ── SUPPRESSION ───────────────────────────────────────────

  app.get('/contacts/suppression', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId } = req.query as { clientId?: string }

    const rows = await adminDb<SuppressionRow[]>`
      SELECT s.*, c.name AS client_name
      FROM email_suppressions s
      LEFT JOIN clients c ON c.id = s.client_id
      WHERE (${clientId ?? null}::uuid IS NULL
             OR s.client_id = ${clientId ?? null}
             OR s.client_id IS NULL)
      ORDER BY s.created_at DESC
      LIMIT 500
    `
    reply.send(rows.map(r => ({
      id:         r.id,
      email:      r.email,
      reason:     r.reason,
      clientId:   r.client_id,
      clientName: r.client_name,
      global:     r.client_id === null,
      createdAt:  r.created_at,
    })))
  })

  app.delete('/contacts/suppression/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`DELETE FROM email_suppressions WHERE id = ${id}`
    reply.status(204).send()
  })

  // ── POSTAL WEBHOOK ────────────────────────────────────────
  // No operator auth — Postal POSTs here. Validates X-Postal-Signature
  // when POSTAL_WEBHOOK_SECRET is configured.

  app.post('/webhooks/postal', { config: { rawBody: true } }, async (req, reply) => {
    const secret = config.email.postalWebhookSecret
    if (secret) {
      const sig = req.headers['x-postal-signature'] as string | undefined
      const body = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body))
      const expected = createHmac('sha256', secret).update(body).digest('base64')
      if (!sig || sig !== expected) {
        app.log.warn('Postal webhook signature mismatch')
        return reply.status(401).send({ error: 'INVALID_SIGNATURE' })
      }
    }
    try {
      await handlePostalEvent(req.body as Parameters<typeof handlePostalEvent>[0])
      reply.status(200).send({ ok: true })
    } catch (err) {
      app.log.error({ err }, 'Postal webhook error')
      reply.status(200).send({ ok: false })
    }
  })

  // ── EMAIL AUTOMATION FLOWS ────────────────────────────────

  type FlowRow = {
    id: string; client_id: string; client_name: string; name: string
    trigger_key: string | null; status: string
    total_enrolled: number; total_completed: number
    created_at: string; updated_at: string
  }

  app.get('/automations', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId } = req.query as { clientId?: string }

    const rows = await adminDb<FlowRow[]>`
      SELECT f.*, c.name AS client_name
      FROM email_automation_flows f
      JOIN clients c ON c.id = f.client_id
      WHERE (${clientId ?? null}::uuid IS NULL OR f.client_id = ${clientId ?? null})
        AND f.status != 'archived'
      ORDER BY f.created_at DESC
    `
    reply.send(rows.map(mapFlow))
  })

  app.post('/automations', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { clientId, name, steps } = req.body as {
      clientId: string
      name: string
      steps: { stepType: 'send_email' | 'wait'; templateId?: string; domainId?: string; fromName?: string; fromEmail?: string; delayMinutes?: number }[]
    }
    if (!clientId || !name) return reply.status(400).send({ error: 'clientId and name required' })

    const triggerKey = randomBytes(16).toString('hex')

    const [flow] = await adminDb<FlowRow[]>`
      INSERT INTO email_automation_flows (client_id, name, trigger_key)
      VALUES (${clientId}, ${name}, ${triggerKey})
      RETURNING *, (SELECT name FROM clients WHERE id = client_id) AS client_name
    `

    if (steps?.length) {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!
        await adminDb`
          INSERT INTO email_automation_steps
            (flow_id, step_index, step_type, template_id, domain_id, from_name, from_email, delay_minutes)
          VALUES
            (${flow!.id}, ${i}, ${s.stepType},
             ${s.templateId ?? null}, ${s.domainId ?? null},
             ${s.fromName ?? null}, ${s.fromEmail ?? null},
             ${s.delayMinutes ?? 0})
        `
      }
    }

    reply.status(201).send(mapFlow(flow!))
  })

  app.get('/automations/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [flow] = await adminDb<FlowRow[]>`
      SELECT f.*, c.name AS client_name FROM email_automation_flows f
      JOIN clients c ON c.id = f.client_id WHERE f.id = ${id}
    `
    if (!flow) return reply.status(404).send({ error: 'Flow not found' })

    const steps = await adminDb`
      SELECT * FROM email_automation_steps WHERE flow_id = ${id} ORDER BY step_index
    `
    const enrollments = await adminDb<{ status: string; count: string }[]>`
      SELECT status, COUNT(*)::text AS count
      FROM email_automation_enrollments WHERE flow_id = ${id} GROUP BY status
    `
    reply.send({ ...mapFlow(flow), steps, enrollments })
  })

  app.delete('/automations/:id', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }
    await adminDb`UPDATE email_automation_flows SET status = 'archived', updated_at = NOW() WHERE id = ${id}`
    reply.status(204).send()
  })

  // POST /automations/:id/enroll — bulk enroll contacts
  app.post('/automations/:id/enroll', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }

    const [flow] = await adminDb<{ client_id: string }[]>`SELECT client_id FROM email_automation_flows WHERE id = ${id}`
    if (!flow) return reply.status(404).send({ error: 'Flow not found' })

    const contacts = (req.body as { email: string; firstName?: string; lastName?: string }[])
    if (!Array.isArray(contacts) || contacts.length === 0)
      return reply.status(400).send({ error: 'Provide array of { email, firstName?, lastName? }' })

    let enrolled = 0
    for (const c of contacts) {
      if (!c.email?.includes('@')) continue
      const existing = await adminDb`
        SELECT 1 FROM email_automation_enrollments WHERE flow_id = ${id} AND email = ${c.email.toLowerCase()}
      `
      if (existing.length > 0) continue
      await adminDb`
        INSERT INTO email_automation_enrollments (flow_id, client_id, email, first_name, last_name)
        VALUES (${id}, ${flow.client_id}, ${c.email.toLowerCase()}, ${c.firstName ?? null}, ${c.lastName ?? null})
      `
      enrolled++
    }

    await adminDb`
      UPDATE email_automation_flows SET total_enrolled = total_enrolled + ${enrolled}, updated_at = NOW() WHERE id = ${id}
    `
    reply.send({ enrolled })
  })

  app.get('/automations/:id/enrollments', async (req, reply) => {
    if (!assertOp(req, reply)) return
    const { id } = req.params as { id: string }
    const rows = await adminDb`
      SELECT * FROM email_automation_enrollments WHERE flow_id = ${id} ORDER BY created_at DESC LIMIT 200
    `
    reply.send(rows)
  })

}

// ── Mappers ────────────────────────────────────────────────────

// ── Mappers ────────────────────────────────────────────────────

function mapDomain(r: DomainRow) {
  return {
    id:             r.id,
    clientId:       r.client_id,
    clientName:     r.client_name,
    domain:         r.domain,
    spfVerified:    r.spf_verified,
    dkimVerified:   r.dkim_verified,
    dmarcVerified:  r.dmarc_verified,
    mxVerified:     r.mx_verified,
    dkimPublicKey:  r.dkim_public_key,
    verified:       r.spf_verified && r.dkim_verified && r.dmarc_verified,
    verifiedAt:     r.verified_at,
    createdAt:      r.created_at,
  }
}

function mapTemplate(r: TemplateRow) {
  return {
    id:         r.id,
    clientId:   r.client_id,
    clientName: r.client_name,
    name:       r.name,
    subject:    r.subject,
    htmlBody:   r.html_body,
    createdAt:  r.created_at,
    updatedAt:  r.updated_at,
  }
}

function mapCampaign(r: CampaignRow) {
  const delivered = Number(r.total_delivered)
  const sent      = Number(r.total_sent)
  const clicked   = Number(r.total_clicked)
  const bounced   = Number(r.total_bounced)
  return {
    id:               r.id,
    clientId:         r.client_id,
    clientName:       r.client_name,
    name:             r.name,
    templateId:       r.template_id,
    templateName:     r.template_name,
    listId:           r.list_id,
    listName:         r.list_name,
    status:           r.status,
    scheduledAt:      r.scheduled_at,
    startedAt:        r.started_at,
    completedAt:      r.completed_at,
    totalRecipients:  Number(r.total_recipients),
    totalSent:        sent,
    totalDelivered:   delivered,
    totalClicked:     clicked,
    totalBounced:     bounced,
    deliveryRate:     calcRate(delivered, sent),
    clickRate:        calcRate(clicked, delivered),
    bounceRate:       calcRate(bounced, sent),
    createdAt:        r.created_at,
  }
}

function calcRate(a: number | string | undefined, b: number | string | undefined): number {
  const an = Number(a ?? 0)
  const bn = Number(b ?? 0)
  if (!bn) return 0
  return Math.round((an / bn) * 10000) / 100
}

function mapFlow(r: { id: string; client_id: string; client_name: string; name: string; trigger_key: string | null; status: string; total_enrolled: number; total_completed: number; created_at: string; updated_at: string }) {
  return {
    id:             r.id,
    clientId:       r.client_id,
    clientName:     r.client_name,
    name:           r.name,
    triggerKey:     r.trigger_key,
    status:         r.status,
    totalEnrolled:  Number(r.total_enrolled),
    totalCompleted: Number(r.total_completed),
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
  }
}

export default emailRoutes
