import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { getProvider } from '@/lib/rpc'

// Cache gas price for 30 seconds to avoid hitting RPC on every stats request
let cachedGasPrice = '0'
let gasPriceCachedAt = 0
const GAS_PRICE_TTL = 30_000

// Use pg_class.reltuples for instant approximate counts.
// COUNT(*) on millions of rows takes 10-30s and kills the health check.
async function getTableEstimate(tableName: string): Promise<number> {
  try {
    const result = await db.execute(
      sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = ${tableName}`
    )
    const n = Number(Array.from(result)[0]?.estimate ?? 0)
    return n < 0 ? 0 : n
  } catch {
    return 0
  }
}

export async function GET(request: Request) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  // Fast path: reltuples + MAX(number) — all complete in <100ms
  let latestBlock = 0
  let totalTransactions = 0
  let totalTokens = 0
  try {
    const [blockResult, txEstimate, tokenEstimate] = await Promise.all([
      db.execute(sql`SELECT MAX(number) AS max FROM blocks`),
      getTableEstimate('transactions'),
      getTableEstimate('tokens'),
    ])
    latestBlock = Number(Array.from(blockResult)[0]?.max ?? 0)
    totalTransactions = txEstimate
    totalTokens = tokenEstimate
  } catch {
    // DB not ready — return empty stats so health check still passes
    return NextResponse.json({ latestBlock: 0, totalTransactions: 0, totalTokens: 0, avgGasPrice: '0' }, { status: 200 })
  }

  // Gas price from RPC — cached for 30s to avoid hitting RPC on every request
  let avgGasPrice = cachedGasPrice
  if (Date.now() - gasPriceCachedAt > GAS_PRICE_TTL) {
    try {
      const feeData = await Promise.race([
        getProvider().getFeeData(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ])
      avgGasPrice = (feeData.gasPrice ?? BigInt(0)).toString()
      cachedGasPrice = avgGasPrice
      gasPriceCachedAt = Date.now()
    } catch {
      // RPC slow or unavailable — use cached value
    }
  }

  return NextResponse.json(
    {
      latestBlock,
      totalTransactions,
      totalTokens,
      avgGasPrice,
      // String versions for consumers that need precision beyond MAX_SAFE_INTEGER
      latestBlockStr: String(latestBlock),
      totalTransactionsStr: String(totalTransactions),
    },
    { status: 200 },
  )
}
