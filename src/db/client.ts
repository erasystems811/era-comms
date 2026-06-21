import postgres from 'postgres'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

// Primary connection pool — used for all application queries
export const db = postgres(config.db.url, {
  max: config.db.maxConnections,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: (notice) => {
    logger.debug({ notice }, 'PostgreSQL notice')
  },
})

// Sentinel UUID that identifies an admin connection to the RLS policies.
// is_admin_context() in the DB checks for this value; when present, all
// RLS policies allow full cross-client visibility.
export const ADMIN_SENTINEL = '00000000-0000-0000-0000-000000000001'

// Admin connection pool — sees across all clients via the sentinel GUC.
// Access is enforced at the application layer via OPERATOR_SECRET; the DB
// layer enforces it via is_admin_context() inside each RLS policy.
// No BYPASSRLS or superuser role required.
export const adminDb = postgres(config.db.url, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: {
    'app.current_client_id': ADMIN_SENTINEL,
  },
  onnotice: (notice) => {
    logger.debug({ notice }, 'PostgreSQL notice')
  },
})

// ── RLS CONTEXT HELPER ────────────────────────────────────────
//
// Every client-facing query must run inside withClient(). The function opens
// a transaction, sets app.current_client_id as a transaction-local variable
// (visible to all RLS policies in this transaction), executes the caller's
// work, then commits.
//
// Usage:
//   const result = await withClient(clientId, async (tx) => {
//     return tx<Message[]>`SELECT * FROM messages WHERE conversation_id = ${id}`
//   })
//
// Do NOT use the module-level `db` directly for client-scoped queries —
// the RLS policies will reject or return empty results.

export async function withClient<T>(
  clientId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // postgres.js begin() infers return type through UnwrapPromiseArray which
  // doesn't satisfy the generic T constraint — cast is safe here.
  return db.begin(async (tx): Promise<T> => {
    await tx`SELECT set_config('app.current_client_id', ${clientId}, true)`
    return fn(tx)
  }) as Promise<T>
}

// Graceful shutdown — call on SIGTERM/SIGINT
export async function closeDb(): Promise<void> {
  await db.end()
  await adminDb.end()
}
