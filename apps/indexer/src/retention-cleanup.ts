/**
 * 90-day retention cleanup for BNB Chain indexer.
 *
 * Deletes rows older than RETENTION_DAYS from high-volume tables.
 * Runs once daily. Safe to run while indexer is live — uses batched
 * deletes to avoid long-running locks.
 *
 * Delete order respects FK: transactions → blocks (transactions.block_number
 * references blocks.number, so transactions must be deleted first).
 */
import { getDb } from './db'
import { sql } from 'drizzle-orm'

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '7', 10)
const BATCH_SIZE     = 50_000  // rows per delete batch — 5K was too slow to catch up
const RUN_EVERY_MS   = 6 * 60 * 60 * 1000    // 6 hours
// Holder-count recompute scans token_balances and updates tokens — takes
// 10-20s on BNB under load and holds DB-pool slots while running, which
// starves the block indexer and web queries. Every 15min is a reasonable
// default (token-page holder counts are eventually consistent anyway).
// Override with HOLDER_COUNT_INTERVAL_MIN env var if you want faster freshness.
const HOLDER_COUNT_EVERY_MS =
  parseInt(process.env.HOLDER_COUNT_INTERVAL_MIN ?? '15', 10) * 60 * 1000
// Disk size of the DB's attached volume in GB (from Render plan). Used to
// compute disk-% usage in size reports so we catch "DB is 80% full but retention
// found nothing to delete" situations before the disk-full alert fires.
// 0 means unknown — size is still reported, percentage is not.
const DB_DISK_GB     = parseInt(process.env.DB_DISK_GB ?? '0', 10)
// Skip expensive maintenance (holder-count recompute) when the indexer is
// too far behind the tip. Prevents a 30-60s DB-hogging query from compounding
// lag when we're already losing the race to catch up.
const HOLDER_COUNT_LAG_THRESHOLD =
  parseInt(process.env.HOLDER_COUNT_LAG_THRESHOLD ?? '1000', 10)

// Indexer lag reporter — index.ts pushes lag on every batch advance so
// recomputeHolderCounts can decide whether to skip this tick.
let reportedLag = 0
export function reportIndexerLag(lag: number): void {
  reportedLag = lag
}

/**
 * Whitelist of allowed table names and timestamp columns.
 * Using sql.raw() with string interpolation for identifiers is inherently
 * dangerous — we mitigate by strictly validating against this whitelist.
 * PostgreSQL parameterized queries ($1) cannot be used for identifiers
 * (table/column names), only for values.
 */
const ALLOWED_TABLES = new Set([
  'dex_trades', 'token_transfers', 'transactions', 'gas_history', 'blocks', 'logs', 'token_balances',
])
const ALLOWED_COLUMNS = new Set(['timestamp', 'block_number'])

function assertAllowedIdentifier(value: string, kind: 'table' | 'column'): void {
  const allowed = kind === 'table' ? ALLOWED_TABLES : ALLOWED_COLUMNS
  if (!allowed.has(value)) {
    throw new Error(`[retention] Refused ${kind} identifier: "${value}" — not in whitelist`)
  }
  // Defense-in-depth: reject anything that isn't a simple identifier
  if (!/^[a-z_]+$/.test(value)) {
    throw new Error(`[retention] Invalid ${kind} identifier: "${value}" — must be lowercase alpha/underscore only`)
  }
}

/**
 * Translate a timestamp cutoff into a block_number cutoff via the
 * `blocks_timestamp_idx` index. Every high-volume table has a
 * `block_number` index but only some have a `timestamp` index — so
 * deleting by block_number is universally fast, while deleting by
 * timestamp forces sequential scans (observed: 12min/0-row DELETE on
 * the 32GB token_transfers table).
 *
 * Returns the minimum block number whose timestamp is >= cutoff. Rows
 * with block_number strictly less than this are older than the cutoff
 * and safe to delete.
 *
 * If the blocks table is empty or has no block past the cutoff, returns
 * null — caller should skip the delete rather than wipe the table.
 */
async function cutoffBlockNumber(cutoff: Date, days: number): Promise<number | null> {
  const db = getDb()
  const cutoffStr = cutoff.toISOString()
  const result = await db.execute(
    sql`SELECT MIN(number)::bigint AS n FROM blocks WHERE timestamp >= ${cutoffStr}::timestamptz`
  )
  const row = Array.from(result)[0] as Record<string, unknown> | undefined
  if (row && row.n !== null && row.n !== undefined) return Number(row.n)

  // Fallback: indexer is stale — latest indexed block is older than wall-clock
  // cutoff (e.g. indexer was down > RETENTION_DAYS, or starting from an old
  // snapshot). Without this, retention becomes a no-op exactly when we need
  // it most. Anchor the cutoff to MAX(timestamp) - days instead, so we still
  // keep only the last N days of INDEXED data. Semantics shift from
  // wall-clock-relative to indexed-data-relative, but retention still makes
  // progress and disk pressure gets relieved.
  const rel = await db.execute(
    sql`SELECT MIN(number)::bigint AS n FROM blocks
        WHERE timestamp >= (SELECT MAX(timestamp) - (${days} * INTERVAL '1 day') FROM blocks)`
  )
  const relRow = Array.from(rel)[0] as Record<string, unknown> | undefined
  if (!relRow || relRow.n === null || relRow.n === undefined) return null
  console.warn(
    `[retention] no blocks past wall-clock cutoff — falling back to ` +
    `indexed-data-relative cutoff (last ${days}d of indexed blocks)`
  )
  return Number(relRow.n)
}

async function deleteByBlockNumber(table: string, cutoffBlock: number): Promise<number> {
  assertAllowedIdentifier(table, 'table')
  const db = getDb()
  const result = await db.execute(
    sql`DELETE FROM ${sql.raw(table)} WHERE block_number < ${cutoffBlock}`
  )
  return (result as any).count ?? (result as any).rowCount ?? 0
}

/**
 * Disk % threshold above which runCleanup triggers an emergency re-cleanup
 * with a tighter retention window. Bounded by EMERGENCY_RETENTION_MIN_DAYS
 * so we never nuke the site's recent-data window entirely.
 */
const EMERGENCY_DISK_PCT = 85
const EMERGENCY_RETENTION_MIN_DAYS = 1

/**
 * Log the per-table sizes and total DB size at the end of each retention run.
 * If DB_DISK_GB is set, also logs the disk-% used and WARNs at >70%.
 *
 * Returns the disk-% used (0 if DB_DISK_GB is unset) so callers can take
 * action — e.g. auto-tightening retention when disk pressure is high.
 *
 * This is the dead-man-switch for "retention runs but the DB keeps growing" —
 * a condition that's easy to miss when logs only show "0 rows removed" (which
 * can legitimately happen on a fresh DB with no data older than the retention
 * cutoff, but can also hide a disk about to fill up).
 */
async function reportSizes(): Promise<number> {
  const db = getDb()
  const result = await db.execute(sql`
    SELECT
      pg_database_size(current_database())::bigint                           AS db_bytes,
      COALESCE((SELECT pg_total_relation_size('transactions')), 0)::bigint   AS tx_bytes,
      COALESCE((SELECT pg_total_relation_size('token_transfers')), 0)::bigint AS tt_bytes,
      COALESCE((SELECT pg_total_relation_size('blocks')), 0)::bigint         AS bl_bytes,
      COALESCE((SELECT pg_total_relation_size('logs')), 0)::bigint           AS lg_bytes,
      COALESCE((SELECT pg_total_relation_size('token_balances')), 0)::bigint AS tb_bytes,
      COALESCE((SELECT pg_total_relation_size('dex_trades')), 0)::bigint     AS dx_bytes
  `)
  const row = Array.from(result)[0] as Record<string, unknown>
  const mb = (b: unknown) => Math.round(Number(b) / 1024 / 1024)
  const dbGB = Number(row.db_bytes) / 1024 / 1024 / 1024
  const parts = [
    `total=${dbGB.toFixed(2)}GB`,
    `tx=${mb(row.tx_bytes)}MB`,
    `tt=${mb(row.tt_bytes)}MB`,
    `blocks=${mb(row.bl_bytes)}MB`,
    `logs=${mb(row.lg_bytes)}MB`,
    `tb=${mb(row.tb_bytes)}MB`,
    `dex=${mb(row.dx_bytes)}MB`,
  ]
  if (DB_DISK_GB > 0) {
    const pct = (dbGB / DB_DISK_GB) * 100
    parts.push(`disk=${pct.toFixed(1)}%of${DB_DISK_GB}GB`)
    if (pct >= 70) {
      console.warn(`[retention] ⚠ DB at ${pct.toFixed(1)}% of ${DB_DISK_GB}GB disk — sizes: ${parts.join(' ')}`)
      return pct
    }
    console.log(`[retention] sizes: ${parts.join(' ')}`)
    return pct
  }
  console.log(`[retention] sizes: ${parts.join(' ')}`)
  return 0
}

async function runCleanup(overrideDays?: number): Promise<void> {
  const days = overrideDays ?? RETENTION_DAYS
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const tag = overrideDays !== undefined ? `${days}d emergency` : `${days}d`
  console.log(`[retention] Running cleanup — pruning rows older than ${cutoff.toISOString()} (${tag})`)

  // Translate timestamp cutoff → block_number cutoff ONCE. Every high-volume
  // table has a block_number index; only some have a timestamp index. Deleting
  // by block_number is 100-1000x faster on large tables (observed: 12min/0-row
  // full-scan DELETE on 32GB token_transfers before this change).
  let cutoffBlock: number | null = null
  try {
    cutoffBlock = await cutoffBlockNumber(cutoff, days)
    console.log(`[retention] cutoff block_number = ${cutoffBlock ?? '(none — all blocks older than cutoff)'}`)
  } catch (err) {
    console.error('[retention] cutoffBlockNumber failed:', err instanceof Error ? err.message : err)
  }

  // Delete order: children first, then parents (FK: transactions → blocks).
  // All these tables have a block_number column + index, so we delete by
  // block_number for speed.
  const blockNumberTables = ['dex_trades', 'token_transfers', 'gas_history', 'transactions', 'logs']

  let totalDeleted = 0

  if (cutoffBlock !== null && cutoffBlock > 0) {
    for (const table of blockNumberTables) {
      try {
        console.log(`[retention] Deleting old rows from ${table} (block_number < ${cutoffBlock})...`)
        const deleted = await deleteByBlockNumber(table, cutoffBlock)
        if (deleted > 0) console.log(`[retention] ${table}: deleted ${deleted} rows`)
        totalDeleted += deleted
      } catch (err) {
        console.error(`[retention] ${table} delete failed:`, err instanceof Error ? err.message : err)
      }
    }
  } else {
    console.log('[retention] Skipping block-number deletes — no cutoff block found (blocks table empty or entirely beyond cutoff)')
  }

  // blocks last — only those with no remaining transactions. Gate on the
  // same cutoffBlock we used above so the stale-indexer fallback path stays
  // consistent: if cutoffBlock is null, skip the blocks delete too (can't
  // safely derive a cutoff). blocks.number is the PK so `< cutoffBlock` is
  // trivially indexed.
  if (cutoffBlock !== null && cutoffBlock > 0) {
    try {
      const db = getDb()
      console.log(`[retention] Deleting old rows from blocks (number < ${cutoffBlock})...`)
      const blockResult = await db.execute(
        sql`DELETE FROM blocks WHERE number < ${cutoffBlock}
          AND NOT EXISTS (SELECT 1 FROM transactions WHERE block_number = blocks.number)`
      )
      const blocksDeleted = (blockResult as any).count ?? (blockResult as any).rowCount ?? 0
      if (blocksDeleted > 0) console.log(`[retention] blocks: deleted ${blocksDeleted} rows`)
      totalDeleted += blocksDeleted
    } catch (err) {
      console.error('[retention] blocks delete failed:', err instanceof Error ? err.message : err)
    }
  } else {
    console.log('[retention] Skipping blocks delete — no cutoff block available')
  }

  // Prune zero-balance rows from token_balances — these are former holders whose
  // balance has dropped to zero. They accumulate over time and are safe to delete.
  try {
    const db = getDb()
    const zbResult = await db.execute(sql.raw(`
      DELETE FROM token_balances WHERE balance <= 0
    `))
    const zbCount = (zbResult as any).count ?? (zbResult as any).rowCount ?? 0
    if (zbCount > 0) console.log(`[retention] token_balances: deleted ${zbCount} zero-balance rows`)
    totalDeleted += zbCount
  } catch (err) {
    console.warn('[retention] token_balances cleanup failed:', err instanceof Error ? err.message : err)
  }

  console.log(`[retention] Done — ${totalDeleted} total rows removed`)

  // Size report — gives "Done — 0 rows removed" a tail so we can see growth
  // trajectory from logs alone, without needing to hit the admin endpoint.
  // Warns loudly at >70% disk usage so we catch trouble before the 90% alert.
  const diskPct = await reportSizes().catch(err => {
    console.warn('[retention] size report failed:', err instanceof Error ? err.message : err)
    return 0
  })

  // VACUUM reclaims dead-tuple space for reuse inside Postgres. Plain VACUUM
  // does NOT return space to the OS — only VACUUM FULL does. We run plain
  // VACUUM on every cleanup to keep bloat bounded; VACUUM FULL is gated on
  // the VACUUM_FULL env var because it takes AccessExclusiveLock (stalls
  // indexer + web queries for 10-30min on a 50GB table).
  if (totalDeleted > 0) {
    console.log('[retention] Running VACUUM ANALYZE to reclaim freed disk space...')
    const db = getDb()
    const highVolumeTables = ['transactions', 'token_transfers', 'logs', 'dex_trades', 'gas_history', 'token_balances']
    for (const t of highVolumeTables) {
      assertAllowedIdentifier(t, 'table')
      try {
        await db.execute(sql`VACUUM ANALYZE ${sql.raw(t)}`)
        console.log(`[retention] VACUUM ANALYZE ${t} done`)
      } catch (err) {
        console.warn(`[retention] VACUUM ${t} failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  // Self-heal: if we're still above the emergency threshold AND we have
  // room to tighten the window further, re-run with a shorter cutoff.
  // Only recurses once per cycle (overrideDays is always the minimum).
  if (
    overrideDays === undefined &&
    diskPct >= EMERGENCY_DISK_PCT &&
    days > EMERGENCY_RETENTION_MIN_DAYS
  ) {
    console.warn(
      `[retention] disk at ${diskPct.toFixed(1)}% (>= ${EMERGENCY_DISK_PCT}%) — ` +
      `emergency re-run with ${EMERGENCY_RETENTION_MIN_DAYS}d window`
    )
    await runCleanup(EMERGENCY_RETENTION_MIN_DAYS)
  }
}

async function runVacuumFull(): Promise<void> {
  const db = getDb()
  const tables = ['token_transfers', 'transactions', 'blocks', 'logs', 'dex_trades', 'gas_history', 'token_balances']
  console.log('[retention] VACUUM FULL requested — this will lock tables and take several minutes')
  for (const t of tables) {
    assertAllowedIdentifier(t, 'table')
    try {
      console.log(`[retention] VACUUM FULL ANALYZE ${t} starting...`)
      await db.execute(sql`VACUUM FULL ANALYZE ${sql.raw(t)}`)
      console.log(`[retention] VACUUM FULL ANALYZE ${t} done`)
    } catch (err) {
      console.warn(`[retention] VACUUM FULL ${t} failed:`, err instanceof Error ? err.message : err)
    }
  }
  console.log('[retention] VACUUM FULL complete')
}

/**
 * Recompute tokens.holder_count from current token_balances.
 *
 * Runs as a single SQL statement — much cheaper than tracking deltas
 * per block because it scans token_balances once and groups by token,
 * whereas the per-block CTE re-locked 1000+ rows every block and was
 * the primary throughput ceiling on ETH.
 *
 * Runs every few minutes; eventual consistency is fine for holder counts.
 */
async function recomputeHolderCounts(): Promise<void> {
  if (reportedLag > HOLDER_COUNT_LAG_THRESHOLD) {
    console.log(`[holder-count] skipping — indexer lag ${reportedLag} > ${HOLDER_COUNT_LAG_THRESHOLD}`)
    return
  }
  const db = getDb()
  try {
    const start = Date.now()
    // Only touch rows that will actually change — GREATEST(...,0) so zero-balance
    // tokens without any balance rows drop to 0.
    await db.execute(sql`
      WITH new_counts AS (
        SELECT token_address, COUNT(*)::int AS cnt
        FROM token_balances
        WHERE balance > 0
        GROUP BY token_address
      )
      UPDATE tokens t
      SET holder_count = COALESCE(nc.cnt, 0)
      FROM (
        SELECT address FROM tokens
      ) all_t
      LEFT JOIN new_counts nc ON nc.token_address = all_t.address
      WHERE t.address = all_t.address
        AND t.holder_count IS DISTINCT FROM COALESCE(nc.cnt, 0)
    `)
    console.log(`[holder-count] recompute done in ${Date.now() - start}ms`)
  } catch (err) {
    console.warn('[holder-count] recompute failed:', err instanceof Error ? err.message : err)
  }
}

export async function startRetentionCleanup(): Promise<void> {
  // Previously awaited runCleanup() here so getLastIndexedBlock saw a clean
  // state. But with 3-day retention on a 15GB/day DB, the startup DELETE
  // saturates the 12-connection pool for 30+ minutes — starving the block
  // workers and the holder-balance queue drainer, causing the queue to grow
  // unboundedly on every restart. The 6h interval below catches the same
  // work without blocking startup; the pool stays hot for block processing.
  const STARTUP_DELAY_MS = 15 * 60 * 1000
  console.log(`[retention] startup cleanup deferred by ${STARTUP_DELAY_MS / 60_000}min to avoid DB-pool starvation`)
  setTimeout(() => {
    runCleanup().catch(err => console.error('[retention] cleanup error:', err))
  }, STARTUP_DELAY_MS)

  // One-time VACUUM FULL to reclaim disk space after bulk deletes.
  // Set VACUUM_FULL=1 in env vars, then remove it after the indexer restarts.
  if (process.env.VACUUM_FULL === '1') {
    runVacuumFull().catch(err => console.error('[retention] VACUUM FULL error:', err))
  }

  setInterval(() => {
    runCleanup().catch(err => console.error('[retention] cleanup error:', err))
  }, RUN_EVERY_MS)

  // Recompute holder_count periodically (replaces per-block inline tracking).
  // First run is delayed so it doesn't collide with the retention job above.
  console.log(`[holder-count] recompute every ${HOLDER_COUNT_EVERY_MS / 60_000}min`)
  setTimeout(() => {
    recomputeHolderCounts().catch(err => console.error('[holder-count] initial error:', err))
    setInterval(() => {
      recomputeHolderCounts().catch(err => console.error('[holder-count] interval error:', err))
    }, HOLDER_COUNT_EVERY_MS)
  }, 60_000)
}
