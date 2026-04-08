import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // allow up to 5 min for large deletes

const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

/**
 * POST /api/admin/db-prune
 * Prunes old data to reclaim disk space. Now covers ALL high-volume tables.
 * Requires Authorization: Bearer <ADMIN_SECRET> header.
 *
 * Query params:
 *   ?dry=true        — report what would be deleted without deleting
 *   ?days=7          — retention period in days (default: 7)
 *   ?vacuum=full     — run VACUUM FULL instead of plain VACUUM (reclaims disk to OS, but locks table)
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const dry = request.nextUrl.searchParams.get('dry') === 'true'
  const days = parseInt(request.nextUrl.searchParams.get('days') ?? '7', 10)
  const vacuumMode = request.nextUrl.searchParams.get('vacuum') ?? 'regular'

  if (days < 1 || days > 365) {
    return NextResponse.json({ error: 'days must be between 1 and 365' }, { status: 400 })
  }

  try {
    const results: Record<string, unknown> = { retentionDays: days }
    const mb = (b: unknown) => Math.round(Number(b) / 1024 / 1024)
    const interval = `${days} days`

    // 1. Current table sizes (all high-volume tables)
    const sizeResult = await db.execute(sql`
      SELECT
        (SELECT pg_total_relation_size('transactions')) as tx_bytes,
        (SELECT pg_total_relation_size('token_transfers')) as tt_bytes,
        (SELECT pg_total_relation_size('blocks')) as blocks_bytes,
        (SELECT pg_total_relation_size('logs')) as logs_bytes,
        (SELECT pg_total_relation_size('gas_history')) as gas_bytes,
        (SELECT pg_total_relation_size('dex_trades')) as dex_bytes,
        (SELECT pg_size_pretty(pg_database_size(current_database()))) as db_size,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'transactions') as tx_rows,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'token_transfers') as tt_rows,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'blocks') as block_rows
    `)
    const sizes = Array.from(sizeResult)[0] as Record<string, unknown>

    results.before = {
      totalDB: sizes.db_size,
      transactionsMB: mb(sizes.tx_bytes),
      tokenTransfersMB: mb(sizes.tt_bytes),
      blocksMB: mb(sizes.blocks_bytes),
      logsMB: mb(sizes.logs_bytes),
      gasHistoryMB: mb(sizes.gas_bytes),
      dexTradesMB: mb(sizes.dex_bytes),
      txRows: Number(sizes.tx_rows),
      ttRows: Number(sizes.tt_rows),
      blockRows: Number(sizes.block_rows),
    }

    if (dry) {
      // Estimate rows that would be deleted from the big tables
      const [txCount, ttCount, blockCount] = await Promise.all([
        db.execute(sql.raw(`SELECT COUNT(*)::bigint as c FROM transactions WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)),
        db.execute(sql.raw(`SELECT COUNT(*)::bigint as c FROM token_transfers WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)),
        db.execute(sql.raw(`SELECT COUNT(*)::bigint as c FROM blocks WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)),
      ])

      results.wouldDelete = {
        transactions: Number((Array.from(txCount)[0] as Record<string, unknown>).c),
        tokenTransfers: Number((Array.from(ttCount)[0] as Record<string, unknown>).c),
        blocks: Number((Array.from(blockCount)[0] as Record<string, unknown>).c),
      }
      results.mode = 'dry-run'
      return NextResponse.json(results)
    }

    // 2. Bulk delete in order: token_transfers → transactions → blocks (FK order)
    //    Each wrapped in try/catch so one failure doesn't abort the rest.
    const deleted: Record<string, number | string> = {}
    const errors: string[] = []

    const safeDelete = async (name: string, query: string) => {
      try {
        const result = await db.execute(sql.raw(query))
        const count = (result as any).rowCount ?? 0
        deleted[name] = count
        console.log(`[db-prune] ${name}: deleted ${count} rows`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deleted[name] = `error: ${msg.slice(0, 100)}`
        errors.push(`${name}: ${msg.slice(0, 100)}`)
        console.error(`[db-prune] ${name} failed:`, msg)
      }
    }

    await safeDelete('tokenTransfers',
      `DELETE FROM token_transfers WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)
    await safeDelete('dexTrades',
      `DELETE FROM dex_trades WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)
    await safeDelete('gasHistory',
      `DELETE FROM gas_history WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)
    await safeDelete('logs',
      `DELETE FROM logs WHERE block_number < (
        SELECT COALESCE(MIN(number), 0) FROM blocks
        WHERE "timestamp" > NOW() - INTERVAL '${interval}')`)
    await safeDelete('transactions',
      `DELETE FROM transactions WHERE "timestamp" < NOW() - INTERVAL '${interval}'`)
    await safeDelete('blocks',
      `DELETE FROM blocks WHERE "timestamp" < NOW() - INTERVAL '${interval}'
        AND NOT EXISTS (SELECT 1 FROM transactions WHERE block_number = blocks.number)`)

    if (errors.length > 0) results.errors = errors

    results.deleted = deleted

    // 3. VACUUM to reclaim space
    const tablesToVacuum = ['token_transfers', 'transactions', 'blocks', 'logs', 'dex_trades', 'gas_history']
    const vacuumCmd = vacuumMode === 'full' ? 'VACUUM FULL ANALYZE' : 'VACUUM ANALYZE'
    for (const t of tablesToVacuum) {
      try {
        await db.execute(sql.raw(`${vacuumCmd} ${t}`))
        console.log(`[db-prune] ${vacuumCmd} ${t} done`)
      } catch (err) {
        console.warn(`[db-prune] ${vacuumCmd} ${t} failed:`, err instanceof Error ? err.message : err)
      }
    }
    results.vacuumed = vacuumMode

    // 4. Sizes after
    const afterResult = await db.execute(sql`
      SELECT
        (SELECT pg_total_relation_size('transactions')) as tx_bytes,
        (SELECT pg_total_relation_size('token_transfers')) as tt_bytes,
        (SELECT pg_total_relation_size('blocks')) as blocks_bytes,
        (SELECT pg_size_pretty(pg_database_size(current_database()))) as db_size
    `)
    const after = Array.from(afterResult)[0] as Record<string, unknown>
    results.after = {
      totalDB: after.db_size,
      transactionsMB: mb(after.tx_bytes),
      tokenTransfersMB: mb(after.tt_bytes),
      blocksMB: mb(after.blocks_bytes),
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
