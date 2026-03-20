import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, desc, or } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { address } = await params

  if (!ADDRESS_REGEX.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const [transactions, tokenTransfers, contracts] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(
        or(
          eq(schema.transactions.fromAddress, address),
          eq(schema.transactions.toAddress, address),
        ),
      )
      .orderBy(desc(schema.transactions.timestamp))
      .limit(20),
    db
      .select()
      .from(schema.tokenTransfers)
      .where(
        or(
          eq(schema.tokenTransfers.fromAddress, address),
          eq(schema.tokenTransfers.toAddress, address),
        ),
      )
      .orderBy(desc(schema.tokenTransfers.timestamp))
      .limit(20),
    db
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.address, address))
      .limit(1),
  ])

  const isContract = contracts.length > 0

  return NextResponse.json({ transactions, tokenTransfers, isContract }, { status: 200 })
}
