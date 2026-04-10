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
const HOLDER_COUNT_EVERY_MS = 5 * 60 * 1000   // 5 minutes

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

async function deleteAll(table: string, timestampCol: string, cutoff: Date): Promise<number> {
  assertAllowedIdentifier(table, 'table')
  assertAllowedIdentifier(timestampCol, 'column')
  const db = getDb()
  const cutoffStr = cutoff.toISOString()
  // Direct DELETE — faster than ctid batching for large backlogs.
  // Single query lets Postgres plan the delete optimally.
  const result = await db.execute(
    sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(timestampCol)} < ${cutoffStr}::timestamptz`
  )
  return (result as any).rowCount ?? 0
}

async function runCleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  console.log(`[retention] Running cleanup — pruning rows older than ${cutoff.toISOString()} (${RETENTION_DAYS}d)`)

  // Delete order: children first, then parents (FK: transactions → blocks)
  const tables: Array<{ table: string; col: string }> = [
    { table: 'dex_trades',      col: 'timestamp' },
    { table: 'token_transfers', col: 'timestamp' },
    { table: 'gas_history',     col: 'timestamp' },
    { table: 'transactions',    col: 'timestamp' },
  ]

  let totalDeleted = 0

  for (const { table, col } of tables) {
    try {
      console.log(`[retention] Deleting old rows from ${table}...`)
      const deleted = await deleteAll(table, col, cutoff)
      if (deleted > 0) console.log(`[retention] ${table}: deleted ${deleted} rows`)
      totalDeleted += deleted
    } catch (err) {
      console.error(`[retention] ${table} delete failed:`, err instanceof Error ? err.message : err)
    }
  }

  // logs: no timestamp — delete by block_number via subquery
  try {
    const db = getDb()
    const cutoffStr = cutoff.toISOString()
    console.log('[retention] Deleting old rows from logs...')
    const logsResult = await db.execute(
      sql`DELETE FROM logs WHERE block_number < (
        SELECT COALESCE(MIN(number), 0) FROM blocks WHERE timestamp >= ${cutoffStr}::timestamptz
      )`
    )
    const logsDeleted = (logsResult as any).rowCount ?? 0
    if (logsDeleted > 0) console.log(`[retention] logs: deleted ${logsDeleted} rows`)
    totalDeleted += logsDeleted
  } catch (err) {
    console.error('[retention] logs delete failed:', err instanceof Error ? err.message : err)
  }

  // blocks last — only those with no remaining transactions
  try {
    const db = getDb()
    const cutoffStr = cutoff.toISOString()
    console.log('[retention] Deleting old rows from blocks...')
    const blockResult = await db.execute(
      sql`DELETE FROM blocks WHERE timestamp < ${cutoffStr}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM transactions WHERE block_number = blocks.number)`
    )
    const blocksDeleted = (blockResult as any).rowCount ?? 0
    if (blocksDeleted > 0) console.log(`[retention] blocks: deleted ${blocksDeleted} rows`)
    totalDeleted += blocksDeleted
  } catch (err) {
    console.error('[retention] blocks delete failed:', err instanceof Error ? err.message : err)
  }

  // Prune zero-balance rows from token_balances — these are former holders whose
  // balance has dropped to zero. They accumulate over time and are safe to delete.
  try {
    const db = getDb()
    const zbResult = await db.execute(sql.raw(`
      DELETE FROM token_balances WHERE balance <= 0
    `))
    const zbCount = (zbResult as any).rowCount ?? 0
    if (zbCount > 0) console.log(`[retention] token_balances: deleted ${zbCount} zero-balance rows`)
    totalDeleted += zbCount
  } catch (err) {
    console.warn('[retention] token_balances cleanup failed:', err instanceof Error ? err.message : err)
  }

  console.log(`[retention] Done — ${totalDeleted} total rows removed`)

  // VACUUM reclaims disk space from dead tuples left by the deletes above.
  // Must run outside a transaction — postgres.js execute() handles this fine.
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
  // Await first run so getLastIndexedBlock sees the clean state
  await runCleanup().catch(err => console.error('[retention] cleanup error:', err))

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
  setTimeout(() => {
    recomputeHolderCounts().catch(err => console.error('[holder-count] initial error:', err))
    setInterval(() => {
      recomputeHolderCounts().catch(err => console.error('[holder-count] interval error:', err))
    }, HOLDER_COUNT_EVERY_MS)
  }, 60_000)
}
