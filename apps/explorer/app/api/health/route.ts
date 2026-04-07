import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { getCacheSizes, getTotalCacheEntries } from '@/lib/cache-registry'
import { getRateLimitMapSize } from '@bnbscan/explorer-core'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Use a lightweight query with a timeout — avoid blocking the health check
    // if the DB is under pressure. The blocks table has an index on number (PK).
    let lagSeconds: number | null = null
    let latestBlockNumber: number | null = null
    try {
      const [latest] = await Promise.race([
        db
          .select({ number: schema.blocks.number, timestamp: schema.blocks.timestamp })
          .from(schema.blocks)
          .orderBy(desc(schema.blocks.number))
          .limit(1),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('db timeout')), 3000)),
      ])
      latestBlockNumber = latest?.number ?? null
      lagSeconds = latest
        ? Math.floor((Date.now() - new Date(latest.timestamp).getTime()) / 1000)
        : null
    } catch {
      // DB slow or down — still report memory health
    }

    // Memory diagnostics
    const mem = process.memoryUsage()
    const fmt = (bytes: number) => Math.round(bytes / 1024 / 1024)
    const heapUsedMB = fmt(mem.heapUsed)
    const heapTotalMB = fmt(mem.heapTotal)
    const rssMB = fmt(mem.rss)

    // Cache diagnostics
    const caches = getCacheSizes()
    caches['rate-limit'] = getRateLimitMapSize()
    const totalCacheEntries = getTotalCacheEntries() + getRateLimitMapSize()

    // Determine health status based on memory
    const heapLimitMB = 1200
    const heapWarnMB = 900
    let memoryStatus: 'ok' | 'warning' | 'critical' = 'ok'
    if (heapUsedMB > heapLimitMB) memoryStatus = 'critical'
    else if (heapUsedMB > heapWarnMB) memoryStatus = 'warning'

    return NextResponse.json({
      status: memoryStatus === 'critical' ? 'degraded' : 'ok',
      latestBlock: latestBlockNumber,
      lagSeconds,
      memory: {
        status: memoryStatus,
        heapUsedMB,
        heapTotalMB,
        rssMB,
        externalMB: fmt(mem.external),
        arrayBuffersMB: fmt(mem.arrayBuffers),
      },
      caches,
      totalCacheEntries,
      uptime: Math.round(process.uptime()),
    })
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: err instanceof Error ? err.message : 'unknown' },
      { status: 503 },
    )
  }
}
