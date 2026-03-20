import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle> | null = null

/**
 * Returns the singleton Drizzle DB client.
 * DATABASE_URL env var must be set before the first call.
 * Subsequent calls ignore the argument and return the cached instance.
 */
export function getDb() {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL environment variable is not set')
  const sql = postgres(url, { max: 10 })
  _db = drizzle(sql, { schema })
  return _db
}

export { schema }
export type Db = ReturnType<typeof getDb>
