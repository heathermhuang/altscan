import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, count } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'

export async function GET(request: Request) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 20)))

  if (isNaN(page) || isNaN(limit)) {
    return NextResponse.json({ error: 'Invalid pagination parameters' }, { status: 400 })
  }

  const offset = (page - 1) * limit

  let blocks, totalResult
  try {
    ;[blocks, totalResult] = await Promise.all([
      db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(limit).offset(offset),
      db.select({ count: count() }).from(schema.blocks),
    ])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const total = Number(totalResult[0]?.count ?? 0)

  return apiJson({ blocks, total, page, limit })
}
