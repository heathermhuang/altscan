import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiListPage } from '@/lib/list-depth'
import { apiJson } from '@/lib/api-serialize'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!(await checkIpRateLimit(request.headers))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  // Newest 10,000 rows at most: a deeper OFFSET would walk the table (lib/list-depth.ts).
  const paging = apiListPage(searchParams)
  if ('error' in paging) return NextResponse.json({ error: paging.error }, { status: 400 })
  const { page, limit, offset } = paging

  let blocks, totalResult
  try {
    // Use reltuples estimate instead of COUNT(*) — full count on 35M+ rows caused OOM
    ;[blocks, totalResult] = await Promise.all([
      db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(limit).offset(offset),
      db.execute(sql`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'blocks'`),
    ])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const total = Math.max(0, Number((Array.from(totalResult)[0] as Record<string, unknown>)?.count ?? 0))

  return apiJson({ blocks, total, page, limit })
}
