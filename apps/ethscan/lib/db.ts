/**
 * EthScan database client — reads ETH_DATABASE_URL, NOT DATABASE_URL.
 * The shared @bnbscan/db package uses a globalThis singleton keyed to DATABASE_URL
 * (the BSC database). We need a completely separate connection for the Ethereum DB.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
// Import only the schema (not getDb — that singleton uses DATABASE_URL, not ETH_DATABASE_URL)
import { schema } from '@bnbscan/db'

// Separate globalThis keys so BSC and ETH connections never collide.
const g = globalThis as typeof globalThis & {
  __ethscan_db?: ReturnType<typeof drizzle>
  __ethscan_sql?: postgres.Sql
}

function getEthDb() {
  if (g.__ethscan_db) return g.__ethscan_db

  const url = process.env.ETH_DATABASE_URL
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ETH_DATABASE_URL environment variable is not set')
    }
    console.warn('[ethscan/db] ETH_DATABASE_URL not set — DB queries will fail at runtime')
    const sql = postgres('postgresql://localhost:5432/ethscan', { max: 1, connect_timeout: 2 })
    g.__ethscan_sql = sql
    g.__ethscan_db = drizzle(sql, { schema })
    return g.__ethscan_db
  }

  // max:5 — leaves headroom for eth-indexer (max:10) within Render Standard's 25 connections.
  const sql = postgres(url, { max: 5 })
  g.__ethscan_sql = sql
  g.__ethscan_db = drizzle(sql, { schema })
  return g.__ethscan_db
}

export const db = getEthDb()
export { schema }
