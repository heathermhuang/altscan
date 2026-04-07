import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { getCacheSizes, getTotalCacheEntries } from '@/lib/cache-registry'
import { getRateLimitMapSize } from '@bnbscan/explorer-core'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Use lightweight queries with timeouts — avoid blocking the health check
    let lagSeconds: number | null = null
    let latestBlockNumber: number | null = null
    let database: Record<string, unknown> | null = null

    try {
      const [latestResult, dbSizeResult] = await Promise.all([
        Promise.race([
          db
            .select({ number: schema.blocks.number, timestamp: schema.blocks.timestamp })
            .from(schema.blocks)
            .orderBy(desc(schema.blocks.number))
            .limit(1),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]),
        Promise.race([
          db.execute(sql`
            SELECT
              pg_database_size(current_database()) as db_bytes,
              (SELECT reltuples::bigint FROM pg_class WHERE relname = 'transactions') as tx_rows,
              (SELECT reltuples::bigint FROM pg_class WHERE relname = 'token_transfers') as tt_rows,
              (SELECT reltuples::bigint FROM pg_class WHERE relname = 'blocks') as block_rows,
              (SELECT COUNT(*)::int FROM pg_stat_activity WHERE state = 'active') as active_conns,
              (SELECT COUNT(*)::int FROM pg_stat_activity) as total_conns
          `),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]).catch(() => null),
      ])

      const latest = latestResult[0]
      latestBlockNumber = latest?.number ?? null
      lagSeconds = latest
        ? Math.floor((Date.now() - new Date(latest.timestamp).getTime()) / 1000)
        : null

      if (dbSizeResult) {
        const row = Array.from(dbSizeResult)[0] as Record<string, unknown>
        database = {
          sizeMB: Math.round(Number(row.db_bytes) / 1024 / 1024),
          txRows: Number(row.tx_rows),
          tokenTransferRows: Number(row.tt_rows),
          blockRows: Number(row.block_rows),
          activeConns: Number(row.active_conns),
          totalConns: Number(row.total_conns),
        }
      }
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
      database,
    })
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: err instanceof Error ? err.message : 'unknown' },
      { status: 503 },
    )
  }
}
