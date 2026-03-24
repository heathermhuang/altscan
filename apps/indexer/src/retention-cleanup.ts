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
import { getDb } from '@bnbscan/db'
import { sql } from 'drizzle-orm'

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '90', 10)
const BATCH_SIZE     = 5_000   // rows per delete batch — keeps lock time short
const RUN_EVERY_MS   = 24 * 60 * 60 * 1000   // 24 hours

async function deleteBatch(table: string, timestampCol: string, cutoff: Date): Promise<number> {
  const db = getDb()
  // Use a subquery with LIMIT to batch-delete without a cursor
  const result = await db.execute(sql.raw(`
    DELETE FROM ${table}
    WHERE ctid IN (
      SELECT ctid FROM ${table}
      WHERE ${timestampCol} < '${cutoff.toISOString()}'
      LIMIT ${BATCH_SIZE}
    )
  `))
  return (result as any).rowCount ?? 0
}

async function deleteLogsOlderThan(cutoff: Date): Promise<number> {
  // logs has no timestamp — prune by block_number via correlated subquery
  const db = getDb()
  const result = await db.execute(sql.raw(`
    DELETE FROM logs
    WHERE ctid IN (
      SELECT l.ctid FROM logs l
      JOIN blocks b ON b.number = l.block_number
      WHERE b.timestamp < '${cutoff.toISOString()}'
      LIMIT ${BATCH_SIZE}
    )
  `))
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

  console.log(`[retention] Done — ${totalDeleted} total rows removed`)
}

export async function startRetentionCleanup(): Promise<void> {
  // Await first run so getLastIndexedBlock sees the clean state
  await runCleanup().catch(err => console.error('[retention] cleanup error:', err))
  setInterval(() => {
    runCleanup().catch(err => console.error('[retention] cleanup error:', err))
  }, RUN_EVERY_MS)
}
