import { adminDb } from '../db/client.js'
import { logger } from '../shared/logger.js'

export interface AuditLogOptions {
  actor: string
  actorLabel: string
  action: string
  target: string
  targetId: string
  detail: string
}

export async function auditLog(opts: AuditLogOptions): Promise<void> {
  try {
    await adminDb`
      INSERT INTO audit_log (actor, actor_label, action, target, target_id, detail)
      VALUES (${opts.actor}, ${opts.actorLabel}, ${opts.action}, ${opts.target}, ${opts.targetId}, ${opts.detail})
    `
  } catch (err) {
    logger.warn({ err, action: opts.action }, 'Failed to write audit log entry')
  }
}
