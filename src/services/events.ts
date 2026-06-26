import { adminDb } from '../db/client.js'
import { logger } from '../shared/logger.js'

export type EventSeverity = 'info' | 'warning' | 'critical'

export interface LogEventOptions {
  eventType: string
  severity?: EventSeverity
  detail: string
  clientId?: string | null
  sessionId?: string | null
  metadata?: Record<string, unknown>
}

export async function logEvent(opts: LogEventOptions): Promise<void> {
  try {
    await adminDb`
      INSERT INTO platform_events (client_id, session_id, event_type, severity, detail, metadata)
      VALUES (
        ${opts.clientId ?? null},
        ${opts.sessionId ?? null},
        ${opts.eventType},
        ${opts.severity ?? 'info'},
        ${opts.detail},
        ${JSON.stringify(opts.metadata ?? {})}
      )
    `
  } catch (err) {
    logger.warn({ err, eventType: opts.eventType }, 'Failed to write platform event')
    throw err
  }
}
