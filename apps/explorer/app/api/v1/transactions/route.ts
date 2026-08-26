import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 20)))

  if (isNaN(page) || isNaN(limit)) {
    return NextResponse.json({ error: 'Invalid pagination parameters' }, { status: 400 })
  }

  const offset = (page - 1) * limit

  let transactions, totalResult
  try {
    // Use reltuples estimate instead of COUNT(*) — full count on 35M+ rows caused OOM
    ;[transactions, totalResult] = await Promise.all([
      db
        .select()
        .from(schema.transactions)
        // (blockNumber, txIndex), NOT timestamp: every tx in a block shares one
        // timestamp, so ordering by it alone is unstable. tx_block_idx covers the
        // blockNumber leg; txIndex only breaks ties within a single block.
        .orderBy(desc(schema.transactions.blockNumber), desc(schema.transactions.txIndex))
        .limit(limit)
        .offset(offset),
      db.execute(sql`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'transactions'`),
    ])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const total = Math.max(0, Number((Array.from(totalResult)[0] as Record<string, unknown>)?.count ?? 0))

  return apiJson({ transactions, total, page, limit })
}
