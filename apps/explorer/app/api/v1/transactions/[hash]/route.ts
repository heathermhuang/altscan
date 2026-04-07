import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { hash } = await params

  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: 'Invalid transaction hash' }, { status: 400 })
  }

  let transactions
  try {
    transactions = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.hash, hash))
      .limit(1)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (transactions.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return apiJson({ transaction: transactions[0] })
}
