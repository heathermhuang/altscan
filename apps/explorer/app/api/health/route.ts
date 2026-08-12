import { NextRequest, NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { getCacheSizes, getTotalCacheEntries } from '@/lib/cache-registry'
import { getDataProviderHealth } from '@/lib/providers'
import { getRateLimitMapSize } from '@altscan/explorer-core'
import { GAP_SUMMARY_SQL, summarizeGapRow, completenessStatus } from '@/lib/index-gaps'

export const dynamic = 'force-dynamic'

const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

export async function GET(request: NextRequest) {
  // Check if caller is authenticated for detailed diagnostics
  const auth = request.headers.get('authorization') ?? ''
  const isAdmin = ADMIN_SECRET && auth === `Bearer ${ADMIN_SECRET}`

  try {
    let lagSeconds: number | null = null
    let latestBlockNumber: number | null = null
    let database: Record<string, unknown> | null = null

    try {
      const queries: Promise<unknown>[] = [
        Promise.race([
          db
            .select({ number: schema.blocks.number, timestamp: schema.blocks.timestamp })
            .from(schema.blocks)
            .orderBy(desc(schema.blocks.number))
            .limit(1),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]),
      ]

      // Only run expensive DB diagnostics for authenticated requests
      if (isAdmin) {
        queries.push(
          Promise.race([
            db.execute(sql`
              SELECT
                (SELECT pg_total_relation_size('transactions') +
                        pg_total_relation_size('token_transfers') +
                        pg_total_relation_size('blocks') +
                        pg_total_relation_size('logs')) as est_bytes,
                (SELECT reltuples::bigint FROM pg_class WHERE relname = 'transactions') as tx_rows,
                (SELECT reltuples::bigint FROM pg_class WHERE relname = 'token_transfers') as tt_rows,
                (SELECT reltuples::bigint FROM pg_class WHERE relname = 'blocks') as block_rows,
                (SELECT reltuples::bigint FROM pg_class WHERE relname = 'logs') as log_rows,
                (SELECT COUNT(*)::int FROM pg_stat_activity WHERE state = 'active') as active_conns,
                (SELECT COUNT(*)::int FROM pg_stat_activity) as total_conns
            `),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]).catch(() => null),
        )
      }

      const results = await Promise.all(queries)
      const latestResult = results[0] as Array<{ number: number; timestamp: Date }>

      const latest = latestResult[0]
      latestBlockNumber = latest?.number ?? null
      lagSeconds = latest
        ? Math.floor((Date.now() - new Date(latest.timestamp).getTime()) / 1000)
        : null

      if (isAdmin && results[1]) {
        const row = Array.from(results[1] as Iterable<Record<string, unknown>>)[0]
        database = {
          sizeMB: Math.round(Number(row.est_bytes) / 1024 / 1024),
          txRows: Number(row.tx_rows),
          tokenTransferRows: Number(row.tt_rows),
          blockRows: Number(row.block_rows),
          logRows: Number(row.log_rows),
          activeConns: Number(row.active_conns),
          totalConns: Number(row.total_conns),
        }
      }
    } catch {
      // DB slow or down — still report basic health
    }

    // Index completeness — separate from liveness, because they fail
    // independently. The 2026-08-04→08-11 incident was a LIVE, responsive
    // indexer silently abandoning ~92,000 blocks; every existing signal here
    // stayed green. `null` means "cannot tell" (e.g. the explorer deployed ahead
    // of the indexer that creates `index_gaps`) and is deliberately NOT reported
    // as healthy.
    let completeness: Record<string, unknown>
    try {
      const gapResult = await Promise.race([
        db.execute(sql.raw(GAP_SUMMARY_SQL)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ])
      const summary = summarizeGapRow(
        Array.from(gapResult as Iterable<Record<string, unknown>>)[0],
      )
      completeness = {
        status: completenessStatus(summary),
        gapCount: summary.count,
        missingBlocks: summary.missingBlocks,
        oldestGapFrom: summary.oldestFromBlock,
      }
    } catch (err) {
      // NEVER swallow this into a null that reads as "fine". A typo in the query
      // or a missing table would otherwise disable the completeness signal
      // permanently and invisibly — reproducing the exact blind spot this whole
      // block exists to close. `unknown` is explicitly not `ok`, and carries the
      // reason, so `completeness.status != "ok"` is a usable alert rule.
      completeness = {
        status: 'unknown',
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      }
    }

    // Public response: status + block info only
    const response: Record<string, unknown> = {
      status: 'ok',
      latestBlock: latestBlockNumber,
      lagSeconds,
      completeness,
    }

    // Abandoned blocks degrade the PUBLIC status. This is the signal that was
    // missing: status.altscan.io polls unauthenticated, so gating it behind the
    // admin secret would reproduce exactly the blind spot being fixed.
    if (completeness?.status === 'degraded') response.status = 'degraded'

    // Memory pressure drives the top-level status for ALL callers — the public
    // status page (status.altscan.io) polls unauthenticated and must still see
    // 'degraded' when heap is critical. Only the detailed numbers stay admin-only.
    const mem = process.memoryUsage()
    const fmt = (bytes: number) => Math.round(bytes / 1024 / 1024)
    const heapUsedMB = fmt(mem.heapUsed)
    const heapLimitMB = 1200
    const heapWarnMB = 900
    let memoryStatus: 'ok' | 'warning' | 'critical' = 'ok'
    if (heapUsedMB > heapLimitMB) memoryStatus = 'critical'
    else if (heapUsedMB > heapWarnMB) memoryStatus = 'warning'
    if (memoryStatus === 'critical') response.status = 'degraded'

    // Authenticated response: add memory, caches, DB diagnostics
    if (isAdmin) {
      const heapTotalMB = fmt(mem.heapTotal)

      const caches = getCacheSizes()
      caches['rate-limit'] = getRateLimitMapSize()

      response.memory = {
        status: memoryStatus,
        heapUsedMB,
        heapTotalMB,
        rssMB: fmt(mem.rss),
        externalMB: fmt(mem.external),
        arrayBuffersMB: fmt(mem.arrayBuffers),
      }
      response.caches = caches
      response.totalCacheEntries = getTotalCacheEntries() + getRateLimitMapSize()
      response.uptime = Math.round(process.uptime())
      response.database = database
      // Response key stays `moralis` — admin-dashboard contract.
      response.moralis = await getDataProviderHealth()
    }

    return NextResponse.json(response)
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: err instanceof Error ? err.message : 'unknown' },
      { status: 503 },
    )
  }
}
