import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../infra/postgres',
)

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

      await sql.begin(async (tx) => {
        await tx.unsafe(content)
        await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`
      })

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
