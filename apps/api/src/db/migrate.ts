import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))
// Arbitrary constant shared by every instance of this app.
const MIGRATION_LOCK_ID = 727_001

// Applies pending migrations before the server accepts traffic. A session
// advisory lock serialises instances that boot at the same time; the
// later ones find nothing left to apply. `max: 1` keeps the lock and the
// migration on the same connection.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    await client`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER })
    } finally {
      await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`
    }
  } finally {
    await client.end()
  }
}
