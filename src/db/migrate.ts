import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../infra/migrations',
)

// Split SQL source into individual statements so each one is sent as its own
// simple query (autocommit). Sending all statements as a single query causes
// Supabase to wrap them in an implicit transaction, which forbids statements
// like CREATE MATERIALIZED VIEW WITH DATA and TimescaleDB continuous aggregates.
//
// Handles: dollar-quoted strings ($$...$$, $tag$...$tag$), single-quoted
// strings, single-line comments, and multi-line comments.
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!

    // Dollar-quoted string: $$...$$ or $tag$...$tag$
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(/^\$([^$]*)\$/)
      if (tagMatch) {
        const tag = tagMatch[0]
        const closePos = sql.indexOf(tag, i + tag.length)
        if (closePos !== -1) {
          current += sql.slice(i, closePos + tag.length)
          i = closePos + tag.length
          continue
        }
      }
    }

    // Single-line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      current += end === -1 ? sql.slice(i) : sql.slice(i, end + 1)
      i = end === -1 ? sql.length : end + 1
      continue
    }

    // Multi-line comment
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      current += end === -1 ? sql.slice(i) : sql.slice(i, end + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }

    // Single-quoted string (handles '' escape)
    if (ch === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2
        } else if (sql[j] === "'") {
          j++
          break
        } else {
          j++
        }
      }
      current += sql.slice(i, j)
      i = j
      continue
    }

    // Statement terminator
    if (ch === ';') {
      current += ch
      i++
      const trimmed = current.trim()
      if (trimmed.length > 1) {
        statements.push(trimmed)
      }
      current = ''
      continue
    }

    current += ch
    i++
  }

  const trailing = current.trim()
  if (trailing) statements.push(trailing)

  return statements
}

async function migrate(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })

  try {
    // Migration tracking table — must exist before we can check applied status
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `

    // Exclusive advisory lock prevents concurrent migration runs (e.g. rolling deploys).
    // Released automatically when the connection closes in the finally block.
    await sql`SELECT pg_advisory_lock(7261952318)`

    const allFiles = await readdir(MIGRATIONS_DIR)
    const migrationFiles = allFiles
      .filter((f) => f.endsWith('.sql'))
      .sort()  // lexicographic order: 001_, 002_, etc.

    let applied = 0
    let skipped = 0

    for (const filename of migrationFiles) {
      const already = await sql`
        SELECT 1 FROM schema_migrations WHERE filename = ${filename}
      `

      if (already.length > 0) {
        console.log(`  skip  ${filename}`)
        skipped++
        continue
      }

      const content = await readFile(join(MIGRATIONS_DIR, filename), 'utf-8')

      // Execute each statement individually so every one runs in autocommit
      // mode — Supabase forbids CREATE MATERIALIZED VIEW WITH DATA and
      // TimescaleDB continuous aggregates inside any transaction block.
      const statements = splitStatements(content)
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }

      await sql`INSERT INTO schema_migrations (filename) VALUES (${filename})`

      console.log(`  apply ${filename}`)
      applied++
    }

    console.log(`\nMigrations complete — ${applied} applied, ${skipped} skipped`)
  } finally {
    await sql.end()
  }
}

migrate().catch((err: unknown) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
