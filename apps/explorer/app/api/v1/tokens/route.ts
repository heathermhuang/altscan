import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, eq, sql } from 'drizzle-orm'
import { checkIpRateLimit, rateLimitResponse } from '@/lib/api-rate-limit'
import { apiListPage } from '@/lib/list-depth'
import { parseTokenType } from '@/lib/token-type-label'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!(await checkIpRateLimit(request.headers))) {
    return rateLimitResponse()
  }

  const { searchParams } = new URL(request.url)
  const paging = apiListPage(searchParams)
  if ('error' in paging) return NextResponse.json({ error: paging.error }, { status: 400 })
  const { limit, offset } = paging
  const type = parseTokenType(searchParams.get('type'))

  let query = db.select().from(schema.tokens).$dynamic()

  if (type) {
    query = query.where(eq(schema.tokens.type, type))
  }

  let tokens: typeof schema.tokens.$inferSelect[] = []
  let total = 0
  try {
    // Use reltuples estimate instead of COUNT(*) to avoid full table scan
    tokens = await query.orderBy(desc(schema.tokens.holderCount)).limit(limit).offset(offset)
    const countResult = await db.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'tokens'`)
    total = Math.max(0, Number((Array.from(countResult)[0] as Record<string, unknown>)?.estimate ?? 0))
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ tokens, total }, { status: 200 })
}
