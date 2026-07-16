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
import { getMaintenanceDb } from './db'
import { sql, type SQL } from 'drizzle-orm'
import { isPartitioned, listTokenTransferPartitions, ensureForwardPartitions } from './ensure-schema'
import { HOLDER_BALANCE_TRACKING_ENABLED } from './block-processor'
import { buildRetentionPlan, parseCompactRetentionDays } from './retention-policy'

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

// ── Batched-maintenance tuning ──────────────────────────────────────
// Every heavy DELETE and the holder-count recompute run in bounded chunks with a
// sleep between them, so they trickle disk I/O to the live indexer instead of
// running as one multi-minute statement. Before this, a single unbounded DELETE +
// a 6-min monolithic recompute saturated the DB's disk I/O and crawled block
// ingestion to ~0.06 blk/s for the whole maintenance window (root cause of the
// periodic ~6-min stall). All are env-tunable.
const RETENTION_DELETE_BATCH = parseInt(process.env.RETENTION_DELETE_BATCH ?? String(BATCH_SIZE), 10) || BATCH_SIZE
const RETENTION_BATCH_SLEEP_MS = (() => {
  const v = parseInt(process.env.RETENTION_BATCH_SLEEP_MS ?? '250', 10)
  return Number.isFinite(v) && v >= 0 ? v : 250
})()
const HOLDER_RECOMPUTE_CHUNK = parseInt(process.env.HOLDER_RECOMPUTE_CHUNK ?? '2000', 10) || 2000
const HOLDER_RECOMPUTE_SLEEP_MS = (() => {
  const v = parseInt(process.env.HOLDER_RECOMPUTE_SLEEP_MS ?? '100', 10)
  return Number.isFinite(v) && v >= 0 ? v : 100
})()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
  const db = getMaintenanceDb()
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

/**
 * Batched, throttled delete. Repeatedly removes up to RETENTION_DELETE_BATCH rows
 * matching `where`, sleeping between batches so a multi-million-row prune trickles
 * disk I/O to the live indexer instead of monopolizing it for minutes.
 *
 * Uses `ctid IN (SELECT ctid … LIMIT n)` — the LIMIT short-circuits, and the inner
 * scan uses whatever index `where` supports (all callers filter on an indexed
 * column). `ident` MUST already be a safe identifier fragment (caller validates);
 * ctid is only unique within a single physical table, so for partitioned data the
 * caller passes the child partition, never the parent.
 */
async function deleteBatchLoop(ident: SQL, where: SQL): Promise<number> {
  const db = getMaintenanceDb()
  let total = 0
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM ${ident}
      WHERE ctid IN (
        SELECT ctid FROM ${ident} WHERE ${where} LIMIT ${RETENTION_DELETE_BATCH}
      )
    `)
    const n = Number((result as any).count ?? (result as any).rowCount ?? 0)
    total += n
    if (n < RETENTION_DELETE_BATCH) break
    await sleep(RETENTION_BATCH_SLEEP_MS)
  }
  return total
}

async function deleteByBlockNumber(table: string, cutoffBlock: number): Promise<number> {
  assertAllowedIdentifier(table, 'table')
  return deleteBatchLoop(sql.raw(table), sql`block_number < ${cutoffBlock}`)
}

/**
 * Throttled in-place UPDATE mirroring deleteBatchLoop: nulls a heavy column on rows
 * matching `where`, in bounded ctid-limited chunks with a sleep between them, so a
 * multi-million-row prune trickles I/O to the live indexer. `setSql` MUST be a safe
 * assignment fragment built by the caller (never from user input).
 *
 * `orderBy` (a column fragment) is a PLAN PIN, not cosmetics: a bare
 * `WHERE … LIMIT n` subselect lets the planner pick seqscan-with-LIMIT — its
 * uniformity assumption says the first n matches arrive a few % into the scan,
 * so it looks cheaper than any index. In reality the matches sit BEHIND the
 * already-pruned prefix (or don't exist, on the final exhaustion batch), so every
 * batch re-reads the whole prefix. Measured on prod BNB 2026-07-16: 193s / 8.7GB
 * read / 14.3M rows filtered for a 0-row batch, with tx_body_unpruned_idx valid
 * but unused. ORDER BY on the indexed column makes seqscan require a sort of the
 * full match estimate, so the ordered (partial-)index scan wins at any pruned
 * fraction — and rows are processed oldest-first, which makes interrupted runs
 * resume deterministically.
 */
async function nullColumnBatchLoop(ident: SQL, setSql: SQL, where: SQL, orderBy?: SQL): Promise<number> {
  const db = getMaintenanceDb()
  const orderClause = orderBy ? sql` ORDER BY ${orderBy}` : sql.raw('')
  let total = 0
  for (;;) {
    const result = await db.execute(sql`
      UPDATE ${ident} SET ${setSql}
      WHERE ctid IN (
        SELECT ctid FROM ${ident} WHERE ${where}${orderClause} LIMIT ${RETENTION_DELETE_BATCH}
      )
    `)
    const n = Number((result as any).count ?? (result as any).rowCount ?? 0)
    total += n
    if (n < RETENTION_DELETE_BATCH) break
    await sleep(RETENTION_BATCH_SLEEP_MS)
  }
  return total
}

/**
 * Body prune for the compact-immortal transactions table: null the heavy `input`
 * calldata and flag the row, keeping the compact projection (from/to/value/method/…)
 * forever. `body_pruned = false` in the predicate makes it idempotent + progressive
 * and lets the loop terminate. The tx page refetches input+logs on demand (Track A1).
 *
 * The predicate spelling `body_pruned = false` must match tx_body_unpruned_idx's
 * WHERE clause (guardrail-tested in ensure-schema.test.ts), and the ORDER BY pin
 * on block_number is what makes the planner actually USE that index — see
 * nullColumnBatchLoop.
 */
async function pruneTransactionBodies(cutoffBlock: number): Promise<number> {
  return nullColumnBatchLoop(
    sql.raw('transactions'),
    sql`input = '0x', body_pruned = true`,
    sql`block_number < ${cutoffBlock} AND body_pruned = false`,
    sql.raw('block_number'),
  )
}

/**
 * Retention for the RANGE-partitioned token_transfers: DROP every partition whose
 * entire block range is below the cutoff (instant, reclaims disk to the OS, no
 * 12-min sequential DELETE, no VACUUM bloat), then a bounded DELETE on the single
 * partition that straddles the cutoff. Returns the number of partitions dropped.
 */
async function pruneTokenTransfersPartitioned(cutoffBlock: number): Promise<number> {
  const db = getMaintenanceDb()
  const parts = await listTokenTransferPartitions()
  let dropped = 0
  for (const p of parts) {
    // Defense-in-depth: partition names come from the pg catalog, but we build the
    // DROP with sql.raw, so refuse anything that isn't a simple identifier.
    if (!/^[a-z_][a-z0-9_]*$/.test(p.name)) {
      console.warn(`[retention] skipping partition with unexpected name: "${p.name}"`)
      continue
    }
    if (p.hi <= cutoffBlock) {
      // Entire partition is older than the cutoff → drop it outright.
      try {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS ${p.name}`))
        console.log(`[retention] dropped token_transfers partition ${p.name} (blocks ${p.lo}–${p.hi - 1})`)
        dropped++
      } catch (err) {
        console.warn(`[retention] drop partition ${p.name} failed:`, err instanceof Error ? err.message : err)
      }
    } else if (p.lo < cutoffBlock && cutoffBlock < p.hi) {
      // Partition straddles the cutoff → delete only the rows below it. Delete
      // directly from the CHILD partition (p.name), not the parent token_transfers:
      // ctid is not unique across a partitioned parent, so the batched ctid-IN loop
      // must target the physical partition. Every row here is in [p.lo, p.hi), so
      // `block_number < cutoffBlock` selects exactly the below-cutoff rows.
      try {
        const n = await deleteBatchLoop(sql.raw(p.name), sql`block_number < ${cutoffBlock}`)
        if (n > 0) console.log(`[retention] boundary partition ${p.name}: deleted ${n} rows below block ${cutoffBlock}`)
      } catch (err) {
        console.warn(`[retention] boundary delete on ${p.name} failed:`, err instanceof Error ? err.message : err)
      }
    }
  }
  return dropped
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
  const db = getMaintenanceDb()
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

async function runCleanup(override?: { bodyDays?: number; compactDays?: number }): Promise<void> {
  const days = override?.bodyDays ?? RETENTION_DAYS
  const compactDays = override?.compactDays ?? parseCompactRetentionDays()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const tag = override !== undefined ? `${days}d body/${compactDays}d compact emergency` : `${days}d body`
  console.log(`[retention] Running cleanup — body cutoff ${cutoff.toISOString()} (${tag}); ` +
    `compact retention = ${Number.isFinite(compactDays) ? compactDays + 'd' : '∞ (immortal)'}`)

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

  // token_transfers is RANGE-partitioned on BNB — relevant only to the compact
  // bridge path below (it's immortal on the default path now).
  const ttPartitioned = await isPartitioned('token_transfers')

  // A2 inversion: the default (body-cutoff) path prunes ONLY refetchable bodies.
  // transactions and token_transfers are compact-immortal here — transactions keeps
  // its row (input is nulled below), token_transfers is untouched. Compact-table row
  // deletes happen only under the explicit finite override (see the compact block).
  const plan = buildRetentionPlan({ ttPartitioned })
  const blockNumberTables = plan.bodyDeleteTables   // ['logs','dex_trades','gas_history']

  let totalDeleted = 0

  if (cutoffBlock !== null && cutoffBlock > 0) {
    // Body row-deletes (refetchable / secondary tables only).
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
    // In-place body prune: null transactions.input on old rows, keep the compact row.
    // Tied to the manifest (if the op is removed, this stops) but prunes explicitly —
    // no dynamic identifier SQL, matching the file's whitelist-only identifier policy.
    if (plan.nullColumnOps.some(o => o.table === 'transactions' && o.column === 'input')) {
      try {
        console.log(`[retention] Pruning transactions.input in place (block_number < ${cutoffBlock})...`)
        const pruned = await pruneTransactionBodies(cutoffBlock)
        if (pruned > 0) console.log(`[retention] transactions.input: pruned ${pruned} rows (kept compact row)`)
        totalDeleted += pruned
      } catch (err) {
        console.error('[retention] transactions.input body prune failed:', err instanceof Error ? err.message : err)
      }
    }
  } else {
    console.log('[retention] Skipping body prune — no cutoff block found (blocks table empty or entirely beyond cutoff)')
  }

  // COMPACT-BRIDGE prune — runs ONLY when COMPACT_RETENTION_DAYS is finite (the
  // explicit per-chain override for the heavy legacy chains). On the default path
  // this whole block is skipped and compact tables (transactions/token_transfers/
  // blocks) are immortal. Deep history on established chains then comes from
  // provider backfill (Track A4).
  if (Number.isFinite(compactDays)) {
    const compactCutoff = new Date(Date.now() - compactDays * 24 * 60 * 60 * 1000)
    let compactCutoffBlock: number | null = null
    try {
      compactCutoffBlock = await cutoffBlockNumber(compactCutoff, compactDays)
    } catch (err) {
      console.error('[retention] compact cutoffBlockNumber failed:', err instanceof Error ? err.message : err)
    }
    if (compactCutoffBlock !== null && compactCutoffBlock > 0) {
      console.warn(`[retention] ⚠ COMPACT override active (${compactDays}d) — pruning compact tables below block ${compactCutoffBlock}`)
      // Body sweep to the SAME cutoff first: when the compact cutoff is NEWER than
      // the body cutoff (emergency re-run tightens only compactDays; or a
      // COMPACT_RETENTION_DAYS < RETENTION_DAYS config), the transactions deleted
      // below would otherwise strand their logs/dex_trades/gas_history rows in the
      // gap window — orphaned exactly when disk pressure is highest. Idempotent:
      // rows below the body cutoff are already gone, so on the normal path
      // (compact ≥ body window) this finds ~nothing.
      for (const table of plan.bodyDeleteTables) {
        try {
          const n = await deleteByBlockNumber(table, compactCutoffBlock)
          if (n > 0) console.log(`[retention] [compact] ${table}: deleted ${n} rows (body sweep to compact cutoff)`)
          totalDeleted += n
        } catch (err) {
          console.error(`[retention] [compact] ${table} body sweep failed:`, err instanceof Error ? err.message : err)
        }
      }
      // token_transfers: partition-drop when partitioned, else row-delete.
      try {
        if (ttPartitioned) {
          const dropped = await pruneTokenTransfersPartitioned(compactCutoffBlock)
          if (dropped > 0) console.log(`[retention] [compact] token_transfers: dropped ${dropped} partition(s)`)
        } else {
          const n = await deleteByBlockNumber('token_transfers', compactCutoffBlock)
          if (n > 0) console.log(`[retention] [compact] token_transfers: deleted ${n} rows`)
          totalDeleted += n
        }
      } catch (err) {
        console.error('[retention] [compact] token_transfers prune failed:', err instanceof Error ? err.message : err)
      }
      // transactions BEFORE blocks (FK transactions.block_number → blocks.number).
      try {
        const n = await deleteByBlockNumber('transactions', compactCutoffBlock)
        if (n > 0) console.log(`[retention] [compact] transactions: deleted ${n} rows`)
        totalDeleted += n
      } catch (err) {
        console.error('[retention] [compact] transactions prune failed:', err instanceof Error ? err.message : err)
      }
      // blocks last — childless only.
      try {
        const n = await deleteBatchLoop(
          sql.raw('blocks'),
          sql`number < ${compactCutoffBlock} AND NOT EXISTS (SELECT 1 FROM transactions WHERE block_number = blocks.number)`,
        )
        if (n > 0) console.log(`[retention] [compact] blocks: deleted ${n} rows`)
        totalDeleted += n
      } catch (err) {
        console.error('[retention] [compact] blocks prune failed:', err instanceof Error ? err.message : err)
      }
    } else {
      console.log('[retention] [compact] no compact cutoff block — skipping compact prune')
    }
  }

  // Prune zero-balance rows from token_balances — former holders whose balance
  // dropped to zero. Deliberately NOT run through deleteBatchLoop: there is no index
  // on `balance`, so a `WHERE balance <= 0 LIMIT n` batch would re-seq-scan the
  // surviving rows every iteration (O(batches × scan)). token_balances is currently
  // static (per-block writes disabled) and mostly pruned already, so this runs as a
  // single bounded statement on the isolated maintenance connection.
  try {
    const db = getMaintenanceDb()
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
    const db = getMaintenanceDb()
    // When token_transfers is partitioned, DROP PARTITION already returned its space
    // to the OS — no VACUUM needed (and we avoid scanning a multi-GB partitioned table).
    const highVolumeTables = ttPartitioned
      ? ['transactions', 'logs', 'dex_trades', 'gas_history', 'token_balances']
      : ['transactions', 'token_transfers', 'logs', 'dex_trades', 'gas_history', 'token_balances']
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

  // Keep forward partitions provisioned (every cycle, not just at boot) so the
  // writer never runs out of range between restarts. No-op unless partitioned.
  if (ttPartitioned) {
    await ensureForwardPartitions().catch(err =>
      console.warn('[retention] ensureForwardPartitions warning:', err instanceof Error ? err.message : err))
  }

  // Self-heal: if still above the emergency threshold, tighten the window that
  // actually holds the disk. When a finite compact override is active, the compact
  // tables are the mass on the heavy chains → tighten compact; otherwise tighten
  // the body window. Only recurses once (override passed = minimum).
  if (override === undefined && diskPct >= EMERGENCY_DISK_PCT) {
    if (Number.isFinite(compactDays) && compactDays > EMERGENCY_RETENTION_MIN_DAYS) {
      console.warn(`[retention] disk at ${diskPct.toFixed(1)}% — emergency compact re-run at ${EMERGENCY_RETENTION_MIN_DAYS}d`)
      await runCleanup({ compactDays: EMERGENCY_RETENTION_MIN_DAYS })
    } else if (days > EMERGENCY_RETENTION_MIN_DAYS) {
      console.warn(`[retention] disk at ${diskPct.toFixed(1)}% — emergency body re-run at ${EMERGENCY_RETENTION_MIN_DAYS}d`)
      await runCleanup({ bodyDays: EMERGENCY_RETENTION_MIN_DAYS })
    }
  }
}

async function runVacuumFull(): Promise<void> {
  const db = getMaintenanceDb()
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
 * Recompute tokens.holder_count from current token_balances, in throttled chunks.
 *
 * Gated on HOLDER_BALANCE_TRACKING_ENABLED: while per-block balance writes are
 * disabled, token_balances is static, so this has no new input and is skipped
 * entirely. The old monolithic single-statement version had grown to ~6 min and
 * saturated disk I/O, stalling block ingestion while updating zero rows.
 *
 * When tracking is on, it pages over tokens by address (keyset) and updates
 * holder_count a chunk at a time with a sleep between chunks, so it never holds the
 * DB's I/O for minutes. Semantics match the old full recompute: a token with no
 * balance>0 rows is set to 0 (LEFT JOIN + COALESCE), and only rows whose count
 * actually changes are written. Eventual consistency is fine for holder counts.
 */
let holderCountDisabledLogged = false
async function recomputeHolderCounts(): Promise<void> {
  if (!HOLDER_BALANCE_TRACKING_ENABLED) {
    // Static token_balances → nothing to recompute. Log the reason once, stay quiet after.
    if (!holderCountDisabledLogged) {
      console.log('[holder-count] recompute disabled — holder-balance tracking is off (token_balances static); skipping')
      holderCountDisabledLogged = true
    }
    return
  }
  if (reportedLag > HOLDER_COUNT_LAG_THRESHOLD) {
    console.log(`[holder-count] skipping — indexer lag ${reportedLag} > ${HOLDER_COUNT_LAG_THRESHOLD}`)
    return
  }
  const db = getMaintenanceDb()
  const start = Date.now()
  let cursor = ''
  let pages = 0
  let updated = 0
  try {
    for (;;) {
      // Keyset page of token addresses (indexed scan on the PK, no OFFSET blowup).
      const page = await db.execute(
        sql`SELECT address FROM tokens WHERE address > ${cursor} ORDER BY address LIMIT ${HOLDER_RECOMPUTE_CHUNK}`
      )
      const addrs = Array.from(page).map(r => (r as Record<string, unknown>).address as string)
      if (addrs.length === 0) break
      cursor = addrs[addrs.length - 1]
      pages++

      const addrValues = sql.join(addrs.map(a => sql`(${a})`), sql`, `)
      const result = await db.execute(sql`
        WITH page(address) AS (VALUES ${addrValues}),
        new_counts AS (
          SELECT token_address, COUNT(*)::int AS cnt
          FROM token_balances
          WHERE balance > 0 AND token_address IN (SELECT address FROM page)
          GROUP BY token_address
        )
        UPDATE tokens t
        SET holder_count = COALESCE(nc.cnt, 0)
        FROM page
        LEFT JOIN new_counts nc ON nc.token_address = page.address
        WHERE t.address = page.address
          AND t.holder_count IS DISTINCT FROM COALESCE(nc.cnt, 0)
      `)
      updated += Number((result as any).count ?? (result as any).rowCount ?? 0)

      if (addrs.length < HOLDER_RECOMPUTE_CHUNK) break
      await sleep(HOLDER_RECOMPUTE_SLEEP_MS)
    }
    console.log(`[holder-count] chunked recompute done in ${Date.now() - start}ms (${pages} pages, ${updated} tokens updated)`)
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
