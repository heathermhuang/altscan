import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { count, max } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { getProvider } from '@/lib/rpc'

export async function GET(request: Request) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  let latestBlockResult, totalTxResult, totalTokensResult
  try {
    ;[latestBlockResult, totalTxResult, totalTokensResult] = await Promise.all([
      db.select({ max: max(schema.blocks.number) }).from(schema.blocks),
      db.select({ count: count() }).from(schema.transactions),
      db.select({ count: count() }).from(schema.tokens),
    ])
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  let avgGasPrice = '0'
  try {
    const feeData = await getProvider().getFeeData()
    avgGasPrice = (feeData.gasPrice ?? BigInt(0)).toString()
  } catch {
    // RPC failure — leave avgGasPrice as '0'
  }

  const latestBlock = Number(latestBlockResult[0]?.max ?? 0)
  const totalTransactions = Number(totalTxResult[0]?.count ?? 0)
  const totalTokens = Number(totalTokensResult[0]?.count ?? 0)

  return NextResponse.json(
    { latestBlock, totalTransactions, totalTokens, avgGasPrice },
    { status: 200 },
  )
}
