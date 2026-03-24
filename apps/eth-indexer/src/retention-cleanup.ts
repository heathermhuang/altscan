/**
 * 90-day retention cleanup for Ethereum indexer.
 *
 * Mirrors apps/indexer/src/retention-cleanup.ts but accepts the drizzle
 * db instance directly (ETH indexer owns its own connection pool).
 */
import { sql } from 'drizzle-orm'

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '30', 10)
const BATCH_SIZE     = 5_000
const RUN_EVERY_MS   = 12 * 60 * 60 * 1000   // 12 hours

async function deleteBatch(db: any, table: string, timestampCol: string, cutoff: Date): Promise<number> {
  const result = await db.execute(sql.raw(`
    DELETE FROM ${table}
    WHERE ctid IN (
      SELECT ctid FROM ${table}
      WHERE ${timestampCol} < '${cutoff.toISOString()}'
      LIMIT ${BATCH_SIZE}
    )
  `))
  return result.rowCount ?? result.count ?? 0
}

async function deleteLogsOlderThan(db: any, cutoff: Date): Promise<number> {
  const result = await db.execute(sql.raw(`
    DELETE FROM logs
    WHERE ctid IN (
      SELECT l.ctid FROM logs l
      JOIN blocks b ON b.number = l.block_number
      WHERE b.timestamp < '${cutoff.toISOString()}'
      LIMIT ${BATCH_SIZE}
    )
  `))
  return result.rowCount ?? result.count ?? 0
}

async function runCleanup(db: any): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  console.log(`[retention] Running cleanup — pruning rows older than ${cutoff.toISOString()} (${RETENTION_DAYS}d)`)

  const tables = [
    { table: 'dex_trades',      col: 'timestamp' },
    { table: 'token_transfers', col: 'timestamp' },
    { table: 'transactions',    col: 'timestamp' },
    { table: 'gas_history',     col: 'timestamp' },
  ]

  let totalDeleted = 0

  for (const { table, col } of tables) {
    let batchTotal = 0, deleted = 0
    do {
      deleted = await deleteBatch(db, table, col, cutoff)
      batchTotal += deleted
    } while (deleted === BATCH_SIZE)
    if (batchTotal > 0) console.log(`[retention] ${table}: deleted ${batchTotal} rows`)
    totalDeleted += batchTotal
  }

  let logsDeleted = 0, batch = 0
  do {
    batch = await deleteLogsOlderThan(db, cutoff)
    logsDeleted += batch
  } while (batch === BATCH_SIZE)
  if (logsDeleted > 0) console.log(`[retention] logs: deleted ${logsDeleted} rows`)
  totalDeleted += logsDeleted

  let blocksDeleted = 0
  batch = 0
  do {
    batch = await deleteBatch(db, 'blocks', 'timestamp', cutoff)
    blocksDeleted += batch
  } while (batch === BATCH_SIZE)
  if (blocksDeleted > 0) console.log(`[retention] blocks: deleted ${blocksDeleted} rows`)
  totalDeleted += blocksDeleted

  console.log(`[retention] Done — ${totalDeleted} total rows removed`)

  // VACUUM reclaims disk space from dead tuples left by the deletes above.
  if (totalDeleted > 0) {
    console.log('[retention] Running VACUUM ANALYZE to reclaim freed disk space...')
    const highVolumeTables = ['transactions', 'token_transfers', 'logs', 'dex_trades', 'gas_history']
    for (const t of highVolumeTables) {
      try {
        await db.execute(sql.raw(`VACUUM ANALYZE ${t}`))
        console.log(`[retention] VACUUM ANALYZE ${t} done`)
      } catch (err) {
        console.warn(`[retention] VACUUM ${t} failed:`, err instanceof Error ? err.message : err)
      }
    }
  }
}

export async function startRetentionCleanup(db: any): Promise<void> {
  // Await first run so getLastIndexedBlock sees the clean state
  await runCleanup(db).catch(err => console.error('[retention] cleanup error:', err))
  setInterval(() => {
    runCleanup(db).catch(err => console.error('[retention] cleanup error:', err))
  }, RUN_EVERY_MS)
}
