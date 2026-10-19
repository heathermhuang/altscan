import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'
import { lookupTxOnChain } from '@/lib/api-tx-lookup'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  if (!(await checkIpRateLimit(request.headers))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { hash: rawHash } = await params

  if (!/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
    return NextResponse.json({ error: 'Invalid transaction hash' }, { status: 400 })
  }
  // The indexer stores hashes lowercased; an uppercase request used to miss the index.
  const hash = rawHash.toLowerCase()

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

  if (transactions.length > 0) {
    return apiJson({ transaction: transactions[0], source: 'index' })
  }

  // The index keeps only recent transactions; older ones come from the chain. Fields the node did
  // not report are null, and `pending: true` means there is no receipt yet (status, gasUsed unknown).
  const chain = await lookupTxOnChain(hash)
  if (chain.kind === 'found') {
    return apiJson({ transaction: chain.tx, source: 'chain' })
  }
  if (chain.kind === 'missing') {
    return NextResponse.json({
      error: 'Not found',
      detail: "Neither this explorer's index nor its node returned this transaction. One broadcast in the last few minutes may not have reached the node yet.",
    }, { status: 404 })
  }
  return NextResponse.json(
    { error: 'Chain lookup unavailable, retry shortly' },
    { status: 503, headers: { 'Retry-After': '30' } },
  )
}
