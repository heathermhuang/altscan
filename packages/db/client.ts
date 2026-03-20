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
  if (!url) {
    // In non-production, allow startup without a DB — queries will fail at request time,
    // which Next.js error boundaries can catch gracefully.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL environment variable is not set')
    }
    console.warn('[bnbscan/db] DATABASE_URL not set — DB queries will fail at runtime')
    const sql = postgres('postgresql://localhost:5432/bnbscan', { max: 1, connect_timeout: 2 })
    _db = drizzle(sql, { schema })
    return _db
  }
  const sql = postgres(url, { max: 10 })
  _db = drizzle(sql, { schema })
  return _db
}

export { schema }
export type Db = ReturnType<typeof getDb>
