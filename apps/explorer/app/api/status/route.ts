import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { getProvider } from '@/lib/rpc'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Used by the /status page to poll indexer health. Returns indexed tip + chain
// tip together so the client can derive indexing speed, chain rate, lag, and
// catch-up ETA from a rolling window of samples.
export async function GET() {
  const now = Date.now()

  const [latestRow, chainTip] = await Promise.all([
    db
      .select({ number: schema.blocks.number, timestamp: schema.blocks.timestamp })
      .from(schema.blocks)
      .orderBy(desc(schema.blocks.number))
      .limit(1),
    getProvider().getBlockNumber().catch(() => null),
  ])

  const latest = latestRow[0]
  return NextResponse.json({
    serverNow: now,
    latestIndexedBlock: latest?.number ?? null,
    latestIndexedTimestamp: latest ? new Date(latest.timestamp).getTime() : null,
    chainTip: chainTip ?? null,
  })
}
