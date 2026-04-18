import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { number: raw } = await params

  if (!/^\d{1,12}$/.test(raw)) {
    return NextResponse.json({ error: 'Invalid block number' }, { status: 400 })
  }

  const num = Number(raw)
  if (!Number.isSafeInteger(num)) {
    return NextResponse.json({ error: 'Invalid block number' }, { status: 400 })
  }

  let blocks
  try {
    blocks = await db
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.number, num))
      .limit(1)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (blocks.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return apiJson({ block: blocks[0] })
}
