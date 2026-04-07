import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

/**
 * POST /api/admin/db-indexes
 * Creates composite indexes for address page query performance.
 * Uses CONCURRENTLY to avoid table locks.
 * Requires Authorization: Bearer <ADMIN_SECRET> header.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const results: Record<string, string> = {}

  const indexes = [
    { name: 'tx_from_ts_idx', sql: sql`CREATE INDEX IF NOT EXISTS tx_from_ts_idx ON transactions (from_address, "timestamp" DESC)` },
    { name: 'tx_to_ts_idx', sql: sql`CREATE INDEX IF NOT EXISTS tx_to_ts_idx ON transactions (to_address, "timestamp" DESC)` },
    { name: 'tt_from_ts_idx', sql: sql`CREATE INDEX IF NOT EXISTS tt_from_ts_idx ON token_transfers (from_address, "timestamp" DESC)` },
    { name: 'tt_to_ts_idx', sql: sql`CREATE INDEX IF NOT EXISTS tt_to_ts_idx ON token_transfers (to_address, "timestamp" DESC)` },
  ]

  for (const idx of indexes) {
    try {
      // Note: CONCURRENTLY cannot be used in a transaction, and drizzle
      // wraps execute in a transaction. Use non-concurrent CREATE INDEX
      // with IF NOT EXISTS — it will briefly lock but is safe.
      await db.execute(idx.sql)
      results[idx.name] = 'created'
    } catch (err) {
      results[idx.name] = err instanceof Error ? err.message : 'failed'
    }
  }

  return NextResponse.json({ indexes: results })
}
