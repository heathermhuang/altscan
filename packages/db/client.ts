import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Use globalThis so the singleton survives Next.js hot-module reloads in dev.
// Without this, each HMR cycle creates a fresh postgres pool, exhausting
// the "too many clients" limit on the database.
const g = globalThis as typeof globalThis & {
  __bnbscan_db?: ReturnType<typeof drizzle>
  __bnbscan_sql?: postgres.Sql
}

/**
 * Returns the singleton Drizzle DB client.
 * DATABASE_URL env var must be set before the first call.
 * Subsequent calls ignore the argument and return the cached instance.
 */
export function getDb() {
  if (g.__bnbscan_db) return g.__bnbscan_db

  const url = process.env.DATABASE_URL
  if (!url) {
    // In non-production, allow startup without a DB — queries will fail at request time,
    // which Next.js error boundaries can catch gracefully.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL environment variable is not set')
    }
    console.warn('[bnbscan/db] DATABASE_URL not set — DB queries will fail at runtime')
    const sql = postgres('postgresql://localhost:5432/bnbscan', { max: 1, connect_timeout: 2 })
    g.__bnbscan_sql = sql
    g.__bnbscan_db = drizzle(sql, { schema })
    return g.__bnbscan_db
  }

  // Pool size configurable via DB_POOL_SIZE env var.
  // Default 5 for web app — leaves headroom for the indexer within Render's 25 connections.
  const poolSize = parseInt(process.env.DB_POOL_SIZE ?? '5', 10) || 5
  const sql = postgres(url, { max: poolSize })
  g.__bnbscan_sql = sql
  g.__bnbscan_db = drizzle(sql, { schema })
  return g.__bnbscan_db
}

export { schema }
export type Db = ReturnType<typeof getDb>
