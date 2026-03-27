import { NextResponse } from 'next/server'
import { getDb, schema } from '@bnbscan/db'
import { desc } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const db = getDb()
    const [latest] = await db
      .select({ number: schema.blocks.number, timestamp: schema.blocks.timestamp })
      .from(schema.blocks)
      .orderBy(desc(schema.blocks.number))
      .limit(1)

    const lagSeconds = latest
      ? Math.floor((Date.now() - new Date(latest.timestamp).getTime()) / 1000)
      : null

    return NextResponse.json({
      status: 'ok',
      latestBlock: latest?.number ?? null,
      lagSeconds,
    })
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: err instanceof Error ? err.message : 'unknown' },
      { status: 503 },
    )
  }
}
