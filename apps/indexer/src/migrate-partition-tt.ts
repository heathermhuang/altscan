/**
 * One-time, supervised migration: convert the monolithic `token_transfers` table
 * into a RANGE-partitioned table (by block_number) WITHOUT copying the 32GB of
 * existing data — the live table is attached as the historical "legacy" partition.
 *
 * Pairs with the async transfer-writer (block-processor.ts): the writer's
 * DELETE+INSERT-per-range idempotency means token_transfers no longer needs a
 * UNIQUE constraint, which is what lets the legacy table attach cleanly (a
 * partitioned table's unique would have to include the partition key).
 *
 * ── RUN THIS WITH THE INDEXER PAUSED ──────────────────────────────────
 *   Scale the BNB indexer service to 0 (or stop it) first.
 *
 * Usage (from apps/indexer, via the Render shell or locally against the target DB):
 *   CHAIN=bnb CONFIRM_PARTITION_MIGRATION=1 node dist/migrate-partition-tt.js
 *   CHAIN=bnb CONFIRM_PARTITION_MIGRATION=1 tsx src/migrate-partition-tt.ts
 * Without CONFIRM_PARTITION_MIGRATION=1 it DRY-RUNS (prints the plan, changes nothing).
 *
 * Design for safety on a live 32GB table:
 *   • Uses a DEDICATED connection with no idle/lifetime recycling and no statement
 *     timeout, so the long index build / validate can't be killed mid-flight.
 *   • Phase 1 (non-blocking): build the new tx_hash index CONCURRENTLY and validate a
 *     CHECK(block_number < S) — both allow concurrent reads, neither holds an
 *     exclusive lock. Idempotent / re-runnable.
 *   • Phase 2 (fast, atomic): a metadata-only transaction (rename, create partitioned
 *     parent + indexes, ATTACH legacy, re-own sequence). Because the CHECK is valid
 *     and legacy already carries every matching index, ATTACH neither scans nor
 *     builds — the ACCESS EXCLUSIVE lock is held for milliseconds. Fully reversible
 *     (rolls back to the original table on any failure).
 *
 * Idempotent overall: already-partitioned → just top up forward partitions; a rolled-
 * back phase 2 → safe to re-run (phase 1 work is reused).
 *
 * Env knobs: PARTITION_BLOCKS (width, default 192000 ≈ 1 day BSC), PARTITION_AHEAD.
 */
import 'dotenv/config'
import { createMaintenanceConnection } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'
import { getDb } from './db'
import { sql } from 'drizzle-orm'
import { isPartitioned, listTokenTransferPartitions, ensureForwardPartitions } from './ensure-schema'

const chain = getChainConfig()
const CONFIRM = process.env.CONFIRM_PARTITION_MIGRATION === '1'
const TAG = `[migrate-partition][${chain.key}]`

// Indexes the monolithic table carries that the partitioned parent also wants. On
// the parent they take the canonical names; on legacy they are renamed to ttl_* so
// ATTACH re-uses them (matched by definition — NO rebuild). Definitions must match.
const MATCHED_INDEXES: Array<{ canonical: string; legacy: string; def: string }> = [
  { canonical: 'tt_token_idx',   legacy: 'ttl_token_idx',   def: 'token_address' },
  { canonical: 'tt_from_ts_idx', legacy: 'ttl_from_ts_idx', def: 'from_address, timestamp DESC' },
  { canonical: 'tt_to_ts_idx',   legacy: 'ttl_to_ts_idx',   def: 'to_address, timestamp DESC' },
  { canonical: 'tt_block_idx',   legacy: 'ttl_block_idx',   def: 'block_number' },
]
// The new tx_hash index (replaces the dropped unique's tx-lookup role). Built on the
// live table CONCURRENTLY in phase 1 under its post-rename name, so ATTACH re-uses it.
const TX_IDX_LEGACY = 'ttl_tx_idx'
const TX_IDX_CANON  = 'tt_tx_idx'
const CHECK_NAME    = 'tt_blk_lt_split'

async function indexValid(name: string): Promise<{ exists: boolean; valid: boolean }> {
  const db = getDb()
  const r = await db.execute(sql`
    SELECT i.indisvalid AS valid FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i' AND c.relname = ${name} LIMIT 1
  `)
  const row = Array.from(r)[0] as Record<string, unknown> | undefined
  return { exists: !!row, valid: !!row?.valid }
}

async function tableExists(name: string): Promise<boolean> {
  const db = getDb()
  const r = await db.execute(sql`SELECT 1 FROM pg_class WHERE relkind IN ('r','p') AND relname = ${name} LIMIT 1`)
  return Array.from(r).length > 0
}

async function constraintExists(table: string, name: string): Promise<boolean> {
  const db = getDb()
  const r = await db.execute(sql`
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relname = ${table} AND con.conname = ${name} LIMIT 1
  `)
  return Array.from(r).length > 0
}

async function main() {
  console.log(`${TAG} target DB env var: ${chain.dbEnvVar}`)

  // ── Already partitioned? Just top up forward partitions and exit. ──
  if (await isPartitioned('token_transfers')) {
    console.log(`${TAG} token_transfers is ALREADY partitioned — nothing to convert.`)
    await ensureForwardPartitions()
    const parts = await listTokenTransferPartitions()
    console.log(`${TAG} ${parts.length} partition(s):`, parts.map(p => `${p.name}[${p.lo},${p.hi})`).join(' '))
    return
  }
  if (!(await tableExists('token_transfers'))) throw new Error(`${TAG} token_transfers does not exist — aborting.`)
  if (await tableExists('token_transfers_legacy')) {
    throw new Error(`${TAG} token_transfers_legacy exists but token_transfers is not partitioned — a previous run was interrupted mid phase-2 (it should have rolled back). Inspect manually.`)
  }

  // Split point S: legacy covers [0, S) = every existing block; new partitions cover [S, ...).
  const maxRow = await getDb().execute(sql`SELECT COALESCE(MAX(block_number), 0)::bigint AS m FROM token_transfers`)
  const maxBlock = Number((Array.from(maxRow)[0] as Record<string, unknown>).m) || 0
  const S = maxBlock + 1
  const width = Math.max(1, parseInt(process.env.PARTITION_BLOCKS ?? '192000', 10))
  const ahead = Math.max(1, parseInt(process.env.PARTITION_AHEAD ?? '7', 10))

  console.log(`${TAG} plan: split S=${S} (max block ${maxBlock}), width=${width}, ahead=${ahead}`)
  console.log(`${TAG}   phase 1 (non-blocking): build ${TX_IDX_LEGACY}(tx_hash) CONCURRENTLY; add+VALIDATE CHECK(block_number < ${S})`)
  console.log(`${TAG}   phase 2 (fast txn): rename→legacy, rename 4 idx→ttl_*, create partitioned parent+indexes, ATTACH legacy [0,${S}), re-own id seq`)
  console.log(`${TAG}   phase 3: provision forward partitions, verify`)

  if (!CONFIRM) {
    console.log(`\n${TAG} DRY RUN — set CONFIRM_PARTITION_MIGRATION=1 (and PAUSE the indexer) to apply. No changes made.`)
    return
  }

  // Dedicated connection: single, no idle/lifetime recycling, no statement timeout —
  // so the long CONCURRENTLY build / VALIDATE can't be killed mid-flight.
  const url = process.env[chain.dbEnvVar]
  if (!url) throw new Error(`${TAG} ${chain.dbEnvVar} not set`)
  const raw = createMaintenanceConnection(url)

  try {
    // ── Phase 1: non-blocking prep (idempotent) ──
    const ix = await indexValid(TX_IDX_LEGACY)
    if (ix.exists && !ix.valid) {
      console.log(`${TAG} dropping leftover INVALID ${TX_IDX_LEGACY} from a prior failed build`)
      await raw.unsafe(`DROP INDEX IF EXISTS ${TX_IDX_LEGACY}`)
    }
    console.log(`${TAG} [1/3] CREATE INDEX CONCURRENTLY ${TX_IDX_LEGACY} (this is the slow step on 32GB)...`)
    const t0 = Date.now()
    await raw.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TX_IDX_LEGACY} ON token_transfers (tx_hash)`)
    console.log(`${TAG}       built in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    if (!(await constraintExists('token_transfers', CHECK_NAME))) {
      await raw.unsafe(`ALTER TABLE token_transfers ADD CONSTRAINT ${CHECK_NAME} CHECK (block_number < ${S}) NOT VALID`)
    }
    console.log(`${TAG} [2/3] VALIDATE CONSTRAINT ${CHECK_NAME} (non-blocking scan)...`)
    await raw.unsafe(`ALTER TABLE token_transfers VALIDATE CONSTRAINT ${CHECK_NAME}`)

    // ── Phase 2: fast, atomic, metadata-only transaction ──
    console.log(`${TAG} [3/3] applying partitioning transaction (brief ACCESS EXCLUSIVE)...`)
    await raw.begin(async (q) => {
      await q.unsafe(`ALTER TABLE token_transfers RENAME TO token_transfers_legacy`)
      for (const m of MATCHED_INDEXES) await q.unsafe(`ALTER INDEX ${m.canonical} RENAME TO ${m.legacy}`)
      await q.unsafe(`CREATE TABLE token_transfers (LIKE token_transfers_legacy INCLUDING DEFAULTS) PARTITION BY RANGE (block_number)`)
      for (const m of MATCHED_INDEXES) await q.unsafe(`CREATE INDEX ${m.canonical} ON token_transfers (${m.def})`)
      await q.unsafe(`CREATE INDEX ${TX_IDX_CANON} ON token_transfers (tx_hash)`)
      // CHECK is valid + legacy has every matching index → ATTACH neither scans nor builds.
      await q.unsafe(`ALTER TABLE token_transfers ATTACH PARTITION token_transfers_legacy FOR VALUES FROM (0) TO (${S})`)
      // Helper CHECK is now redundant (the partition bound enforces it).
      await q.unsafe(`ALTER TABLE token_transfers_legacy DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`)
      // Re-own the id sequence to the new parent so dropping legacy can't drop it.
      await q.unsafe(`ALTER SEQUENCE IF EXISTS token_transfers_id_seq OWNED BY token_transfers.id`)
    })
    console.log(`${TAG} partitioning transaction committed.`)
  } finally {
    await raw.end({ timeout: 5 })
  }

  // ── Phase 3: provision forward partitions + verify (pooled connection is fine) ──
  await ensureForwardPartitions()
  const partitioned = await isPartitioned('token_transfers')
  const parts = await listTokenTransferPartitions()
  const cnt = await getDb().execute(sql`SELECT COUNT(*)::bigint AS c FROM token_transfers`)
  const total = Number((Array.from(cnt)[0] as Record<string, unknown>).c)
  console.log(`${TAG} VERIFY: partitioned=${partitioned}, partitions=${parts.length}, rows readable=${total}`)
  console.log(`${TAG} partitions:`, parts.map(p => `${p.name}[${p.lo},${p.hi})`).join(' '))
  if (!partitioned) throw new Error(`${TAG} post-migration check failed — token_transfers is not partitioned!`)
  console.log(`${TAG} ✓ Done. Resume the indexer — it writes into the new small partitions.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${TAG} FAILED:`, err instanceof Error ? err.stack ?? err.message : err)
    console.error(`${TAG} Phase 2 is transactional, so token_transfers is unchanged if it failed there. Re-run after inspecting.`)
    process.exit(1)
  })
