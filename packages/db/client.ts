import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle> | null = null

export function getDb(connectionString?: string) {
  if (_db) return _db
  const url = connectionString ?? process.env.DATABASE_URL!
  if (!url) throw new Error('DATABASE_URL is not set')
  const sql = postgres(url, { max: 10 })
  _db = drizzle(sql, { schema })
  return _db
}

export { schema }
export type Db = ReturnType<typeof getDb>
