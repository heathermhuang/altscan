import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Use globalThis so the singleton survives Next.js hot-module reloads in dev.
// Without this, each HMR cycle creates a fresh postgres pool, exhausting
// the "too many clients" limit on the database.
// Keyed by env var name so multiple chains can coexist in the same process.
const g = globalThis as typeof globalThis & {
  __db_instances?: Map<string, ReturnType<typeof drizzle>>
  __db_sql?: Map<string, postgres.Sql>
}

/**
 * Returns a singleton Drizzle DB client for the given env var.
 * Defaults to DATABASE_URL for backwards compatibility.
 * Each unique env var name gets its own connection pool.
 */
export function getDb(envVarName = 'DATABASE_URL') {
  if (!g.__db_instances) g.__db_instances = new Map()
  if (!g.__db_sql) g.__db_sql = new Map()

  const cached = g.__db_instances.get(envVarName)
  if (cached) return cached

  const url = process.env[envVarName]
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${envVarName} environment variable is not set`)
    }
    const dbName = envVarName === 'ETH_DATABASE_URL' ? 'ethscan' : 'bnbscan'
    console.warn(`[db] ${envVarName} not set — DB queries will fail at runtime`)
    const sql = postgres(`postgresql://localhost:5432/${dbName}`, { max: 1, connect_timeout: 2 })
    g.__db_sql.set(envVarName, sql)
    const db = drizzle(sql, { schema })
    g.__db_instances.set(envVarName, db)
    return db
  }

  // Pool size configurable via DB_POOL_SIZE env var.
  // Default 5 for web app — leaves headroom for the indexer within Render's 25 connections.
  const poolSize = parseInt(process.env.DB_POOL_SIZE ?? '5', 10) || 5
  const sql = postgres(url, {
    max: poolSize,
    // Recycle idle connections — Render's managed Postgres (and network proxies)
    // can silently close idle TCP connections. Without idle_timeout, the pool
    // hands out dead connections that hang until OS-level TCP keepalive fires
    // (minutes). 20s keeps connections fresh without thrashing.
    idle_timeout: 20,
    // Cap connection lifetime to prevent long-lived connections from accumulating
    // stale prepared statements or hitting Postgres backend memory limits.
    max_lifetime: 300,
    // Fail fast on connection acquisition — don't wait 30s (default) if all pool
    // slots are busy or the DB is unreachable.
    connect_timeout: 10,
  })
  g.__db_sql.set(envVarName, sql)
  const db = drizzle(sql, { schema })
  g.__db_instances.set(envVarName, db)
  return db
}

export { schema }
export type Db = ReturnType<typeof getDb>
