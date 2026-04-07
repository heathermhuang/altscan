import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // allow up to 5 min for large deletes

const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

/**
 * POST /api/admin/db-prune
 * Prunes old low-value data to reclaim disk space.
 * Requires Authorization: Bearer <ADMIN_SECRET> header.
 *
 * Query params:
 *   ?dry=true   — report what would be deleted without deleting
 */
export async function POST(request: NextRequest) {
  // Auth check
  const auth = request.headers.get('authorization')
  if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const dry = request.nextUrl.searchParams.get('dry') === 'true'

  try {
    const results: Record<string, unknown> = {}

    // 1. Check current table sizes
    const sizeResult = await db.execute(sql`
      SELECT
        (SELECT pg_total_relation_size('transactions')) as tx_bytes,
        (SELECT pg_total_relation_size('token_transfers')) as tt_bytes,
        (SELECT pg_total_relation_size('logs')) as logs_bytes,
        (SELECT pg_total_relation_size('gas_history')) as gas_bytes,
        (SELECT pg_total_relation_size('dex_trades')) as dex_bytes,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'logs') as log_rows,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'gas_history') as gas_rows,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'dex_trades') as dex_rows
    `)
    const sizes = Array.from(sizeResult)[0] as Record<string, unknown>
    const mb = (b: unknown) => Math.round(Number(b) / 1024 / 1024)

    results.before = {
      transactionsMB: mb(sizes.tx_bytes),
      tokenTransfersMB: mb(sizes.tt_bytes),
      logsMB: mb(sizes.logs_bytes),
      gasHistoryMB: mb(sizes.gas_bytes),
      dexTradesMB: mb(sizes.dex_bytes),
      logRows: Number(sizes.log_rows),
      gasRows: Number(sizes.gas_rows),
      dexRows: Number(sizes.dex_rows),
    }

    if (dry) {
      // Count what would be deleted
      const [gasCount, logsCount, dexCount] = await Promise.all([
        db.execute(sql`SELECT COUNT(*)::int as c FROM gas_history WHERE "timestamp" < NOW() - INTERVAL '30 days'`),
        db.execute(sql`SELECT COUNT(*)::int as c FROM logs WHERE block_number < (
          SELECT COALESCE(MIN(number), 0) FROM blocks WHERE "timestamp" > NOW() - INTERVAL '60 days'
        )`),
        db.execute(sql`SELECT COUNT(*)::int as c FROM dex_trades WHERE "timestamp" < NOW() - INTERVAL '60 days'`),
      ])

      results.wouldDelete = {
        gasHistory: Number((Array.from(gasCount)[0] as Record<string, unknown>).c),
        logs: Number((Array.from(logsCount)[0] as Record<string, unknown>).c),
        dexTrades: Number((Array.from(dexCount)[0] as Record<string, unknown>).c),
      }
      results.mode = 'dry-run'
      return NextResponse.json(results)
    }

    // 2. Prune gas_history older than 30 days
    const gasResult = await db.execute(sql`
      DELETE FROM gas_history WHERE "timestamp" < NOW() - INTERVAL '30 days'
    `)
    results.gasHistoryDeleted = gasResult.length ?? 'done'

    // 3. Prune logs older than 60 days (biggest space saver)
    const logsResult = await db.execute(sql`
      DELETE FROM logs WHERE block_number < (
        SELECT COALESCE(MIN(number), 0) FROM blocks
        WHERE "timestamp" > NOW() - INTERVAL '60 days'
      )
    `)
    results.logsDeleted = logsResult.length ?? 'done'

    // 4. Prune dex_trades older than 60 days
    const dexResult = await db.execute(sql`
      DELETE FROM dex_trades WHERE "timestamp" < NOW() - INTERVAL '60 days'
    `)
    results.dexTradesDeleted = dexResult.length ?? 'done'

    // 5. VACUUM ANALYZE to reclaim space
    await db.execute(sql`VACUUM ANALYZE gas_history`)
    await db.execute(sql`VACUUM ANALYZE logs`)
    await db.execute(sql`VACUUM ANALYZE dex_trades`)
    results.vacuumed = true

    // 6. Check sizes after
    const afterResult = await db.execute(sql`
      SELECT
        (SELECT pg_total_relation_size('logs')) as logs_bytes,
        (SELECT pg_total_relation_size('gas_history')) as gas_bytes,
        (SELECT pg_total_relation_size('dex_trades')) as dex_bytes
    `)
    const after = Array.from(afterResult)[0] as Record<string, unknown>
    results.after = {
      logsMB: mb(after.logs_bytes),
      gasHistoryMB: mb(after.gas_bytes),
      dexTradesMB: mb(after.dex_bytes),
    }

    results.mode = 'pruned'
    return NextResponse.json(results)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    )
  }
}
