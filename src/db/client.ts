import postgres from 'postgres'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

// Primary connection pool — used for all application queries.
// Cap to 5 to leave room for adminDb and session worker connections
// when PgBouncer session mode is in use (pool_size typically ≤ 20).
// Override with DATABASE_MAX_CONNECTIONS in .env if you need more.
export const db = postgres(config.db.url, {
  max: Math.min(config.db.maxConnections, 5),
  idle_timeout: 30,
  connect_timeout: 30,
  onnotice: (notice) => {
    logger.debug({ notice }, 'Supabase notice')
  },
})

// Sentinel UUID that identifies an admin connection to the RLS policies.
// is_admin_context() in the DB checks for this value; when present, all
// RLS policies allow full cross-client visibility.
export const ADMIN_SENTINEL = '00000000-0000-0000-0000-000000000001'

// Session worker child processes need minimal DB connections.
// Each worker is its own process and creates this pool independently.
const isSessionWorker = process.argv.some((arg) => arg.includes('session-worker'))

// Admin connection pool — sees across all clients via the sentinel GUC.
// Access is enforced at the application layer via OPERATOR_SECRET; the DB
// layer enforces it via is_admin_context() inside each RLS policy.
// No BYPASSRLS or superuser role required.
export const adminDb = postgres(config.db.url, {
  max: isSessionWorker ? 1 : 2,
  idle_timeout: 30,
  connect_timeout: 30,
  connection: {
    'app.current_client_id': ADMIN_SENTINEL,
  },
  onnotice: (notice) => {
    logger.debug({ notice }, 'Supabase notice')
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
