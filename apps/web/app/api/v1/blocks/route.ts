import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, count } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'

export async function GET(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 20)))
  const offset = (page - 1) * limit

  const [blocks, totalResult] = await Promise.all([
    db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(limit).offset(offset),
    db.select({ count: count() }).from(schema.blocks),
  ])

  const total = Number(totalResult[0]?.count ?? 0)

  return NextResponse.json({ blocks, total, page, limit }, { status: 200 })
}
