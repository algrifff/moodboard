import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required')
}

export const pgClient = postgres(DATABASE_URL, { max: 10 })
export const db = drizzle(pgClient, { schema })
export { schema }
