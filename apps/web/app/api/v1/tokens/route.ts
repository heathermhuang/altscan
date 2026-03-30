import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, count, eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'

export async function GET(request: Request) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const rawPage = Number(searchParams.get('page') ?? 1)
  const rawLimit = Number(searchParams.get('limit') ?? 20)
  if (isNaN(rawPage) || isNaN(rawLimit)) {
    return NextResponse.json({ error: 'Invalid pagination parameters' }, { status: 400 })
  }
  const page = Math.max(1, rawPage)
  const limit = Math.min(50, Math.max(1, rawLimit))

  const offset = (page - 1) * limit
  const type = searchParams.get('type') as 'BEP20' | 'BEP721' | 'BEP1155' | null

  const validTypes = ['BEP20', 'BEP721', 'BEP1155']

  let query = db.select().from(schema.tokens).$dynamic()
  let countQuery = db.select({ count: count() }).from(schema.tokens).$dynamic()

  if (type && validTypes.includes(type)) {
    query = query.where(eq(schema.tokens.type, type))
    countQuery = countQuery.where(eq(schema.tokens.type, type))
  }

  let tokens, totalResult
  try {
    ;[tokens, totalResult] = await Promise.all([
      query.orderBy(desc(schema.tokens.holderCount)).limit(limit).offset(offset),
      countQuery,
    ])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const total = Number(totalResult[0]?.count ?? 0)

  return NextResponse.json({ tokens, total }, { status: 200 })
}
