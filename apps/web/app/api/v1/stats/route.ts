import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { count, max } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'
import { getProvider } from '@/lib/rpc'

export async function GET(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const [latestBlockResult, totalTxResult, totalTokensResult, feeData] = await Promise.all([
    db.select({ max: max(schema.blocks.number) }).from(schema.blocks),
    db.select({ count: count() }).from(schema.transactions),
    db.select({ count: count() }).from(schema.tokens),
    getProvider().getFeeData(),
  ])

  const latestBlock = Number(latestBlockResult[0]?.max ?? 0)
  const totalTransactions = Number(totalTxResult[0]?.count ?? 0)
  const totalTokens = Number(totalTokensResult[0]?.count ?? 0)
  const avgGasPrice = (feeData.gasPrice ?? BigInt(0)).toString()

  return NextResponse.json(
    { latestBlock, totalTransactions, totalTokens, avgGasPrice },
    { status: 200 },
  )
}
