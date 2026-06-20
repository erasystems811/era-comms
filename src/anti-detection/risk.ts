// ── RISK SCORER ───────────────────────────────────────────────
//
// Computes a [0.000, 1.000] risk score for a WhatsApp session and
// writes it to whatsapp_sessions.risk_score.
//
// Signals (additive):
//   base           0.05  — every number carries some inherent risk
//   age factor     0–0.20 — new numbers (<30 days) score higher
//   failure rate   0–0.50 — failed / total outbound in last 24 h
//
// Called fire-and-forget after each successful send. A separate
// operator cron will sweep all sessions nightly (Step 8).

import { adminDb } from '../db/client.js'

type SessionStats = {
  session_created_at: string
  failed_24h:         string
  total_24h:          string
}

export async function updateRiskScore(sessionId: string): Promise<void> {
  const rows = (await adminDb`
    SELECT
      ws.created_at::TEXT AS session_created_at,
      COUNT(m.id) FILTER (
        WHERE m.direction = 'outbound'
          AND m.status    = 'failed'
          AND m.created_at > NOW() - INTERVAL '24 hours'
      )::TEXT AS failed_24h,
      COUNT(m.id) FILTER (
        WHERE m.direction = 'outbound'
          AND m.created_at > NOW() - INTERVAL '24 hours'
      )::TEXT AS total_24h
    FROM whatsapp_sessions ws
    LEFT JOIN messages m ON m.session_id = ws.id
    WHERE ws.id = ${sessionId}
    GROUP BY ws.created_at
  `) as unknown as SessionStats[]

  const row = rows[0]
  if (!row) return

  const ageDays      = (Date.now() - new Date(row.session_created_at).getTime()) / 86_400_000
  const failed24h    = parseInt(row.failed_24h,  10)
  const total24h     = parseInt(row.total_24h,   10)
  const failureRate  = total24h > 0 ? failed24h / total24h : 0

  // Age factor decays linearly from 0.20 to 0 over 30 days
  const ageFactor    = Math.max(0, 0.20 - (ageDays / 30) * 0.20)

  const score = Math.max(0, Math.min(1, 0.05 + ageFactor + failureRate * 0.50))

  await adminDb`
    UPDATE whatsapp_sessions
    SET risk_score      = ${score.toFixed(3)},
        risk_updated_at = NOW()
    WHERE id = ${sessionId}
  `
}
