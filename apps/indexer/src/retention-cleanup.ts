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

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '1', 10)
const BATCH_SIZE     = 5_000   // rows per delete batch — keeps lock time short
const RUN_EVERY_MS   = 12 * 60 * 60 * 1000   // 12 hours (was 24h — more frequent on BSC)

/**
 * Whitelist of allowed table names and timestamp columns.
 * Using sql.raw() with string interpolation for identifiers is inherently
 * dangerous — we mitigate by strictly validating against this whitelist.
 * PostgreSQL parameterized queries ($1) cannot be used for identifiers
 * (table/column names), only for values.
 */
const ALLOWED_TABLES = new Set([
  'dex_trades', 'token_transfers', 'transactions', 'gas_history', 'blocks', 'logs',
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

async function deleteBatch(table: string, timestampCol: string, cutoff: Date): Promise<number> {
  assertAllowedIdentifier(table, 'table')
  assertAllowedIdentifier(timestampCol, 'column')
  const db = getDb()
  // Use parameterized value for the cutoff timestamp; identifiers are whitelisted above
  const cutoffStr = cutoff.toISOString()
  const result = await db.execute(
    sql`DELETE FROM ${sql.raw(table)} WHERE ctid IN (SELECT ctid FROM ${sql.raw(table)} WHERE ${sql.raw(timestampCol)} < ${cutoffStr}::timestamptz LIMIT ${BATCH_SIZE})`
  )
  return (result as any).rowCount ?? 0
}

async function deleteLogsOlderThan(cutoff: Date): Promise<number> {
  // logs has no timestamp — prune by block_number via correlated subquery
  const db = getDb()
  const cutoffStr = cutoff.toISOString()
  const result = await db.execute(
    sql`DELETE FROM logs WHERE ctid IN (SELECT l.ctid FROM logs l JOIN blocks b ON b.number = l.block_number WHERE b.timestamp < ${cutoffStr}::timestamptz LIMIT ${BATCH_SIZE})`
  )
  return (result as any).rowCount ?? 0
}

async function runCleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  console.log(`[retention] Running cleanup — pruning rows older than ${cutoff.toISOString()} (${RETENTION_DAYS}d)`)

  const tables: Array<{ table: string; col: string }> = [
    { table: 'dex_trades',      col: 'timestamp' },
    { table: 'token_transfers', col: 'timestamp' },
    { table: 'transactions',    col: 'timestamp' },
    { table: 'gas_history',     col: 'timestamp' },
  ]

  let totalDeleted = 0

  for (const { table, col } of tables) {
    let deleted = 0
    let batchTotal = 0
    do {
      deleted = await deleteBatch(table, col, cutoff)
      batchTotal += deleted
    } while (deleted === BATCH_SIZE)   // keep going until a partial batch
    if (batchTotal > 0) console.log(`[retention] ${table}: deleted ${batchTotal} rows`)
    totalDeleted += batchTotal
  }

  // logs: no timestamp, join via blocks
  let logsDeleted = 0
  let batch = 0
  do {
    batch = await deleteLogsOlderThan(cutoff)
    logsDeleted += batch
  } while (batch === BATCH_SIZE)
  if (logsDeleted > 0) console.log(`[retention] logs: deleted ${logsDeleted} rows`)
  totalDeleted += logsDeleted

  // blocks: delete last — transactions must already be gone
  let blocksDeleted = 0
  batch = 0
  do {
    batch = await deleteBatch('blocks', 'timestamp', cutoff)
    blocksDeleted += batch
  } while (batch === BATCH_SIZE)
  if (blocksDeleted > 0) console.log(`[retention] blocks: deleted ${blocksDeleted} rows`)
  totalDeleted += blocksDeleted

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

export async function startRetentionCleanup(): Promise<void> {
  // Await first run so getLastIndexedBlock sees the clean state
  await runCleanup().catch(err => console.error('[retention] cleanup error:', err))
  setInterval(() => {
    runCleanup().catch(err => console.error('[retention] cleanup error:', err))
  }, RUN_EVERY_MS)
}
