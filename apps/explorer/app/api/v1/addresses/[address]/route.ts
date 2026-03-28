import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, desc, or } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { address } = await params

  if (!ADDRESS_REGEX.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  let transactions, tokenTransfers, contracts
  try {
    ;[transactions, tokenTransfers, contracts] = await Promise.all([
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
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const isContract = contracts.length > 0

  return apiJson({ transactions, tokenTransfers, isContract })
}
