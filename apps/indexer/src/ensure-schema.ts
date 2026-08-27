/**
 * Idempotent schema bootstrap for BNB Chain indexer.
 * Creates all tables and indexes using IF NOT EXISTS so it is safe
 * to call on every startup — either a fresh DB or an existing one.
 */
import { getDb } from './db'
import { sql } from 'drizzle-orm'
import { getChainConfig } from '@altscan/chain-config'

export async function ensureSchema(): Promise<void> {
  const db = getDb()
  console.log('[indexer] Ensuring BNB schema...')

  // Enums (idempotent via DO…EXCEPTION pattern)
  await db.execute(sql.raw(`DO $$ BEGIN CREATE TYPE token_type AS ENUM ('BEP20','BEP721','BEP1155'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`))
  await db.execute(sql.raw(`DO $$ BEGIN CREATE TYPE validator_status AS ENUM ('active','inactive','jailed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`))
  await db.execute(sql.raw(`DO $$ BEGIN CREATE TYPE verify_source AS ENUM ('own','sourcify'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS blocks (
      number           BIGINT PRIMARY KEY,
      hash             VARCHAR(66) UNIQUE NOT NULL,
      parent_hash      VARCHAR(66) NOT NULL,
      timestamp        TIMESTAMPTZ NOT NULL,
      miner            VARCHAR(42) NOT NULL,
      gas_used         BIGINT NOT NULL DEFAULT 0,
      gas_limit        BIGINT NOT NULL DEFAULT 0,
      base_fee_per_gas NUMERIC(36,0),
      tx_count         INTEGER NOT NULL DEFAULT 0,
      size             INTEGER NOT NULL DEFAULT 0
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS transactions (
      hash          VARCHAR(66) PRIMARY KEY,
      block_number  BIGINT NOT NULL REFERENCES blocks(number),
      from_address  VARCHAR(42) NOT NULL,
      to_address    VARCHAR(42),
      value         NUMERIC(78,18) NOT NULL DEFAULT 0,
      gas           BIGINT NOT NULL DEFAULT 0,
      gas_price     NUMERIC(36,0) NOT NULL DEFAULT 0,
      gas_used      BIGINT NOT NULL DEFAULT 0,
      input         TEXT NOT NULL DEFAULT '0x',
      status        BOOLEAN NOT NULL DEFAULT true,
      method_id     VARCHAR(10),
      tx_index      INTEGER NOT NULL DEFAULT 0,
      nonce         INTEGER,
      tx_type       INTEGER,
      timestamp     TIMESTAMPTZ NOT NULL
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS addresses (
      address     VARCHAR(42) PRIMARY KEY,
      tx_count    INTEGER NOT NULL DEFAULT 0,
      label       VARCHAR(255),
      first_seen  TIMESTAMPTZ,
      last_seen   TIMESTAMPTZ
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS token_transfers (
      tx_hash       VARCHAR(66) NOT NULL,
      log_index     INTEGER NOT NULL DEFAULT 0,
      token_address VARCHAR(42) NOT NULL,
      from_address  VARCHAR(42) NOT NULL,
      to_address    VARCHAR(42) NOT NULL,
      value         NUMERIC(78,0) NOT NULL DEFAULT 0,
      token_id      NUMERIC(78,0),
      block_number  BIGINT NOT NULL,
      timestamp     TIMESTAMPTZ NOT NULL,
      UNIQUE (tx_hash, log_index)
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS tokens (
      address      VARCHAR(42) PRIMARY KEY,
      name         VARCHAR(255) NOT NULL,
      symbol       VARCHAR(50) NOT NULL,
      decimals     INTEGER NOT NULL DEFAULT 18,
      type         token_type NOT NULL DEFAULT 'BEP20',
      total_supply NUMERIC(78,0) NOT NULL DEFAULT 0,
      holder_count INTEGER NOT NULL DEFAULT 0,
      logo_url     TEXT
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS logs (
      id           SERIAL PRIMARY KEY,
      tx_hash      VARCHAR(66) NOT NULL,
      log_index    INTEGER NOT NULL,
      address      VARCHAR(42) NOT NULL,
      topic0       VARCHAR(66),
      topic1       VARCHAR(66),
      topic2       VARCHAR(66),
      topic3       VARCHAR(66),
      data         TEXT NOT NULL DEFAULT '0x',
      block_number BIGINT NOT NULL,
      UNIQUE (tx_hash, log_index)
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS token_balances (
      token_address  VARCHAR(42) NOT NULL,
      holder_address VARCHAR(42) NOT NULL,
      balance        NUMERIC(78,0) NOT NULL DEFAULT 0,
      UNIQUE (token_address, holder_address)
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS contracts (
      address          VARCHAR(42) PRIMARY KEY,
      bytecode         TEXT NOT NULL DEFAULT '0x',
      abi              JSONB,
      source_code      TEXT,
      compiler_version VARCHAR(50),
      verified_at      TIMESTAMPTZ,
      verify_source    verify_source,
      license          VARCHAR(100)
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS dex_trades (
      id           SERIAL PRIMARY KEY,
      tx_hash      VARCHAR(66) NOT NULL,
      log_index    INTEGER,
      dex          VARCHAR(50) NOT NULL,
      pair_address VARCHAR(42) NOT NULL,
      token_in     VARCHAR(42) NOT NULL,
      token_out    VARCHAR(42) NOT NULL,
      amount_in    NUMERIC(78,0) NOT NULL DEFAULT 0,
      amount_out   NUMERIC(78,0) NOT NULL DEFAULT 0,
      maker        VARCHAR(42) NOT NULL,
      block_number BIGINT NOT NULL,
      timestamp    TIMESTAMPTZ NOT NULL
    )
  `))

  // Webhook delivery ledger — what makes a webhook fire AT MOST ONCE per block.
  //
  // notifyWebhooks already batches to one POST per webhook per block, so the
  // remaining hazard is not amplification but REPETITION: re-processing a block
  // re-delivers its payload to every matching webhook, and a consumer that
  // credits a balance or forwards an alert has no way to tell the copy from the
  // original. The primary key IS the idempotency key — a claim that conflicts
  // means someone already delivered this (webhook, block).
  //
  // Keyed on the block HASH, not just its number. A reorg replaces height N with
  // a DIFFERENT block N, and that replacement is a genuinely new event its
  // subscribers must see — under a (webhook_id, block_number) key the orphaned
  // block's claim would suppress the canonical block's notification outright.
  // block_number is kept alongside so retention can prune by height.
  //
  // Pruned by retention on the same cutoff as the other refetchable bodies (see
  // BODY_PRUNE_OPS), so it cannot grow without bound.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      webhook_id   INTEGER NOT NULL,
      block_hash   VARCHAR(66) NOT NULL,
      block_number BIGINT  NOT NULL,
      delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (webhook_id, block_hash)
    )
  `))
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS webhook_deliveries_block_idx ON webhook_deliveries (block_number)`,
  ))
  // CREATE TABLE IF NOT EXISTS does NOT reshape a table that already exists. An
  // environment that ran an earlier build of this table (keyed on block_number,
  // no block_hash) would keep that shape, every claim would reference a missing
  // column, and the fail-closed claim path would then suppress webhooks entirely
  // and silently. Add the column and the real key explicitly so the table
  // converges regardless of which build created it.
  await addColumnIfMissing('webhook_deliveries', 'block_hash', 'VARCHAR(66)')
  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_hash_key
      ON webhook_deliveries (webhook_id, block_hash) WHERE block_hash IS NOT NULL
  `))
  // Adding the hash key is not enough on its own: a table created in the earlier
  // shape still carries PRIMARY KEY (webhook_id, block_number), and that key is
  // exactly what breaks reorgs. The replacement block at height N has a new hash
  // but the SAME number, so its claim satisfies the hash key and then violates
  // the legacy one — an error the hash-specific ON CONFLICT does not catch, which
  // drops into the fail-closed path and silently suppresses the canonical block's
  // notification. Drop it so the constraint set matches the intended key.
  try {
    const legacy = await db.execute(sql.raw(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'webhook_deliveries'
        AND c.contype IN ('p', 'u')
        AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
               FROM unnest(c.conkey) k
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
            = ARRAY['block_number','webhook_id']
    `))
    for (const row of Array.from(legacy)) {
      const name = (row as Record<string, unknown>).conname as string
      console.log(`[indexer] dropping legacy webhook_deliveries key ${name} (blocks reorg re-delivery)`)
      await db.execute(sql.raw(`ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS "${name}"`))
    }
  } catch (err) {
    console.error('[indexer] legacy webhook_deliveries key check skipped:', err)
  }

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS validators (
      address      VARCHAR(42) PRIMARY KEY,
      moniker      VARCHAR(255) NOT NULL,
      voting_power NUMERIC(36,0) NOT NULL DEFAULT 0,
      commission   NUMERIC(5,4) NOT NULL DEFAULT 0,
      uptime       NUMERIC(5,4) NOT NULL DEFAULT 0,
      status       validator_status NOT NULL DEFAULT 'active',
      updated_at   TIMESTAMPTZ NOT NULL
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS gas_history (
      id           SERIAL PRIMARY KEY,
      slow         NUMERIC(36,0) NOT NULL DEFAULT 0,
      standard     NUMERIC(36,0) NOT NULL DEFAULT 0,
      fast         NUMERIC(36,0) NOT NULL DEFAULT 0,
      base_fee     NUMERIC(36,0) NOT NULL DEFAULT 0,
      block_number BIGINT NOT NULL,
      timestamp    TIMESTAMPTZ NOT NULL
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id                SERIAL PRIMARY KEY,
      owner_address     VARCHAR(42) NOT NULL,
      url               TEXT NOT NULL,
      watch_address     VARCHAR(42),
      event_types       TEXT[] NOT NULL DEFAULT '{tx}',
      secret            VARCHAR(64),
      active            BOOLEAN NOT NULL DEFAULT true,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_triggered_at TIMESTAMPTZ,
      fail_count        INTEGER NOT NULL DEFAULT 0
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id                  SERIAL PRIMARY KEY,
      key_hash            VARCHAR(64) UNIQUE NOT NULL,
      key_prefix          VARCHAR(12) NOT NULL,
      label               VARCHAR(255),
      owner_address       VARCHAR(42),
      requests_per_minute INTEGER NOT NULL DEFAULT 100,
      total_requests      BIGINT NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at        TIMESTAMPTZ,
      active              BOOLEAN NOT NULL DEFAULT true
    )
  `))

  // Single-row durable cursor for the async token_transfers writer.
  // transfers_durable_block = W: every block ≤ W has all its transfers committed.
  // It is the crash-safe resume point (see index.ts getResumeCursor + block-processor
  // writer). Seed at 0; index.ts initializes it to MAX(blocks.number) on first run.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS indexer_cursor (
      id                      INTEGER PRIMARY KEY DEFAULT 1,
      transfers_durable_block BIGINT NOT NULL DEFAULT 0,
      CONSTRAINT indexer_cursor_singleton CHECK (id = 1)
    )
  `))
  await db.execute(sql.raw(`INSERT INTO indexer_cursor (id, transfers_durable_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`))

  // Deliberately-abandoned block ranges (the MAX_LAG_BLOCKS skip).
  //
  // The skip has always existed; until now it recorded NOTHING, so falling
  // behind cost correctness rather than freshness and did so invisibly —
  // ~92,000 blocks between 2026-08-04 and 08-11 with /api/health reporting "ok"
  // throughout. Recording the range makes the loss both alertable and, later,
  // backfillable.
  //
  // from_block is the PK: a range is identified by where it starts, so a retry
  // of the same skip is idempotent instead of inserting a duplicate. No serial
  // here — an int4 sequence overflow already took token_transfers down once.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS index_gaps (
      from_block BIGINT PRIMARY KEY,
      to_block   BIGINT NOT NULL,
      reason     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      healed_at  TIMESTAMPTZ,
      CONSTRAINT index_gaps_range CHECK (to_block >= from_block)
    )
  `))
  // Heights the indexer has PROVEN unindexable and deliberately stepped over.
  //
  // Deliberately NOT a `reason` value on index_gaps, which is where this lived
  // first. index_gaps is keyed on from_block and its writers merge on conflict
  // (GREATEST on to_block, overwrite on reason), so two gaps that happen to start
  // at the same height silently become one: a bulk max_lag_skip landing on a
  // quarantine erases the quarantine's identity, and a quarantine landing on a
  // max_lag range relabels thousands of blocks as poison. Either direction breaks
  // the resume scan that depends on telling them apart. (codex P1, round 2.)
  //
  // They are genuinely different facts and now live apart: index_gaps records
  // "these blocks are missing" (a range, healable, drives completeness reporting),
  // while this records "this exact height was proven unindexable and skipped" (a
  // per-height decision that the resume scan must honour). Nothing merges here —
  // the height IS the key.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS poison_blocks (
      block_number BIGINT PRIMARY KEY,
      failures     INTEGER NOT NULL DEFAULT 0,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `))

  // Durable heal progress. Blocks at or below heal_cursor have been re-indexed,
  // had the transfer queue DRAINED, and been re-verified — so healing survives a
  // crash. Without it, a crash after re-indexing but before the drain loses the
  // in-memory transfer queue while the block itself survives with a full
  // tx_count, and every content-based test would call it complete. Nothing
  // replays it, because the MAX_LAG skip already jumped the durable watermark
  // past this range. (codex P1, round 3.)
  await db.execute(sql.raw(`ALTER TABLE index_gaps ADD COLUMN IF NOT EXISTS heal_cursor BIGINT`))

  // Lease columns for the gap healer's atomic claim.
  //
  // healInflight is process-LOCAL, and Render rolling deploys overlap generations
  // for ~60-80s (measured, background workers included). Two healers would
  // otherwise select the same absent block before either inserted it and both run
  // processBlock — duplicating dex_trades (serial PK, no unique constraint),
  // double-delivering webhooks, and racing the transfer writer's delete-then-
  // reinsert. That is corruption strictly worse than having no healer.
  // (codex P1, round 7.)
  //
  // The owner column doubles as a fencing token: every heal write requires the
  // lease still be held BY THIS OWNER, so a process whose lease expired cannot
  // land a late write over the new owner's work.
  await db.execute(sql.raw(`ALTER TABLE index_gaps ADD COLUMN IF NOT EXISTS heal_lease_owner TEXT`))
  await db.execute(sql.raw(`ALTER TABLE index_gaps ADD COLUMN IF NOT EXISTS heal_lease_until TIMESTAMPTZ`))

  // Partial index: every read is "what is still missing?", and the healed rows
  // are the ones that accumulate.
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS index_gaps_unhealed_idx ON index_gaps (from_block) WHERE healed_at IS NULL
  `))

  // Runtime-editable explorer settings (admin console) — one JSONB doc per
  // namespace, written via the web app's /api/admin/settings, read at render time.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS explorer_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS explorer_settings_audit (
      id         SERIAL PRIMARY KEY,
      key        TEXT NOT NULL,
      value      JSONB NOT NULL,
      version    INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )
  `))

  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS explorer_settings_audit_key_idx ON explorer_settings_audit (key, id DESC)`,
  ))

  // ── Track A4b: lazy provider backfill (immortal — retention NEVER lists these) ──
  //
  // Mirrors packages/db/schema.ts. Retention exemption is BY CONSTRUCTION:
  // these names appear in neither retention-policy.ts's manifests nor
  // retention-cleanup.ts's ALLOWED_TABLES, and a test pins that.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS backfill_address_txs (
      address         VARCHAR(42) NOT NULL,
      tx_hash         VARCHAR(66) NOT NULL,
      block_number    BIGINT NOT NULL,
      block_timestamp TIMESTAMPTZ NOT NULL,
      from_address    VARCHAR(42) NOT NULL,
      to_address      VARCHAR(42),
      value           NUMERIC(78,0) NOT NULL DEFAULT 0,
      category        VARCHAR(64),
      summary         TEXT,
      possible_spam   BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (address, tx_hash)
    )
  `))
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS backfill_address_txs_addr_block_idx ON backfill_address_txs (address, block_number DESC)`,
  ))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS backfill_token_transfers (
      scope_address   VARCHAR(42) NOT NULL,
      tx_hash         VARCHAR(66) NOT NULL,
      log_index       INTEGER NOT NULL,
      token_address   VARCHAR(42) NOT NULL,
      from_address    VARCHAR(42) NOT NULL,
      to_address      VARCHAR(42) NOT NULL,
      value           NUMERIC(78,0) NOT NULL DEFAULT 0,
      value_formatted TEXT,
      token_symbol    VARCHAR(64),
      token_decimals  INTEGER,
      block_number    BIGINT NOT NULL,
      block_timestamp TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope_address, tx_hash, log_index)
    )
  `))
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS backfill_token_transfers_scope_block_idx ON backfill_token_transfers (scope_address, block_number DESC)`,
  ))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS backfill_watermarks (
      id                       SERIAL PRIMARY KEY,
      entity_type              VARCHAR(24) NOT NULL,
      entity_id                VARCHAR(42) NOT NULL,
      status                   VARCHAR(12) NOT NULL DEFAULT 'pending',
      backfilled_through_block BIGINT,
      oldest_cursor            TEXT,
      rows_written             INTEGER NOT NULL DEFAULT 0,
      attempts                 INTEGER NOT NULL DEFAULT 0,
      last_attempt_at          TIMESTAMPTZ,
      last_error               TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT backfill_watermarks_entity_unique UNIQUE (entity_type, entity_id)
    )
  `))
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS backfill_watermarks_claim_idx ON backfill_watermarks (status, last_attempt_at)`,
  ))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS backfill_budget (
      bucket_hour TIMESTAMPTZ PRIMARY KEY,
      pages_used  INTEGER NOT NULL DEFAULT 0
    )
  `))

  // Column migrations — idempotent ADD COLUMN IF NOT EXISTS for schema evolution.
  //
  // CRITICAL: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` still takes an
  // AccessExclusiveLock on the table even when the column already exists.
  // Under deploy rollover, the old instance's INSERT transactions hold
  // AccessShareLock on `transactions`, and the new instance's ALTER blocks
  // behind them. On BNB under backlog that was observed to stall startup
  // for 9+ minutes before ensureSchema could continue.
  //
  // Fix: check pg_attribute first. If the column already exists, skip the
  // ALTER entirely — no lock acquired, no stall. The ALTER only runs on
  // the very first deploy that introduces a new column.
  await addColumnIfMissing('transactions', 'nonce',    'INTEGER')
  await addColumnIfMissing('transactions', 'tx_type',  'INTEGER')
  await addColumnIfMissing('tokens',       'logo_url', 'TEXT')
  // A2 (retention inversion): marks rows whose heavy `input` body was pruned in
  // place so the tx page knows to refetch it. Lock-safe: addColumnIfMissing skips
  // the ALTER entirely once the column exists (see the CRITICAL note above).
  await addColumnIfMissing('transactions', 'body_pruned', 'BOOLEAN NOT NULL DEFAULT false')
  // Where gap RECORDING began — the bound on /api/health's `ok`. Left NULL here
  // ON PURPOSE, which reports `unverified` until an operator sets it.
  //
  // It is deliberately NOT stamped automatically at boot. Render's rolling
  // deploy overlaps generations (see the AccessExclusiveLock note above — the
  // outgoing instance is still writing while this runs), and the OUTGOING binary
  // skips WITHOUT recording. A baseline stamped during that window would cover
  // blocks the old generation then abandoned unrecorded, so health would report
  // a permanent, confident `ok` over real holes — a worse failure than the
  // silence being fixed, because it looks verified. There is no cooperative fix:
  // the old binary cannot be taught to record retroactively. (codex P1.)
  //
  // Set it once, deliberately, after confirming the new generation is the sole
  // writer (one instance in the Render dashboard, old deploy fully stopped):
  //
  //   UPDATE indexer_cursor
  //      SET gap_tracking_from_block = (SELECT MAX(number) FROM blocks)
  //    WHERE id = 1;
  //
  // Until then `unverified` is the honest answer, and `degraded` still fires on
  // every recorded gap — the alert works regardless of the baseline.
  await addColumnIfMissing('indexer_cursor', 'gap_tracking_from_block', 'BIGINT')

  // The block retention actually prunes below, published by the retention job.
  //
  // The completeness reader and the gap healer both need a retention floor, and
  // both MUST take it from here rather than MIN(blocks.number). When the oldest
  // retained region is itself an abandoned range, the inferred floor sits ABOVE
  // the gap: the gap reads as aged-out, health reports `ok`, and the healer goes
  // idle over damage that is inside the retention window. A floor inferred from
  // the same sparse data whose holes are being measured is circular. (codex P1.)
  //
  // NULL means no floor is known — compact pruning disabled, or retention has
  // not run since this column appeared. That counts everything and heals
  // everything: wasteful at worst, never a false all-clear.
  await addColumnIfMissing('indexer_cursor', 'compact_cutoff_block', 'BIGINT')

  // dex_trades natural key. See schema.ts — until this existed the table's only
  // key was `id serial`, so replaying a block duplicated every trade in it.
  //
  // Deliberately NULLABLE with NO DEFAULT. A sentinel default would be actively
  // harmful: Render overlaps deploy generations, and the outgoing binary does not
  // write this column, so under a default two real swaps in one transaction would
  // both take the sentinel and the new unique index would silently drop one via
  // onConflictDoNothing(). NULL makes that a no-op, and the partial unique index
  // (WHERE log_index IS NOT NULL) simply excludes rows that predate the column —
  // so no backfill runs, and none is needed.
  await addColumnIfMissing('dex_trades', 'log_index', 'INTEGER')

  // Drop any invalid indexes left behind by failed CONCURRENTLY builds.
  // See INVALID_INDEX_SWEEP_SQL for why it must stay scoped to leaf indexes.
  try {
    const invalid = await db.execute(sql.raw(INVALID_INDEX_SWEEP_SQL))
    for (const row of Array.from(invalid)) {
      const name = (row as Record<string, unknown>).index_name as string
      console.log(`[indexer] Dropping invalid index: ${name}`)
      await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`))
    }
  } catch (err) {
    console.warn('[indexer] Could not check for invalid indexes:', err instanceof Error ? err.message : err)
  }

  console.log('[indexer] Schema ready.')

  // Build indexes in background using CONCURRENTLY so startup is never blocked.
  // CONCURRENTLY allows reads/writes during build — safe to run while indexing.
  // Each index is tried individually so a failure on one doesn't block the rest.
  // Drop redundant indexes — composites / unique constraints already cover these.
  // Each saves disk AND per-insert index-maintenance cost on 10M+ row tables.
  // tt_tx_idx(tx_hash) is covered by the tt_tx_log_unique(tx_hash, log_index)
  // unique index's leftmost column, so tx_hash lookups still use an index.
  // Dropping it cuts token_transfers index writes ~1/7 (profiled 2026-06-05:
  // token_transfers inserts were ~50% of BNB block time — the throughput ceiling).
  // token_transfers is RANGE-partitioned post-migration (see migrate-partition-tt.ts).
  // When partitioned, the migration owns its indexes (created ON ONLY parent + then
  // attached) and tt_tx_idx is the tx-lookup index that must be KEPT; CONCURRENTLY
  // index DDL also isn't allowed on a partitioned parent. So branch on it. Pre-
  // migration BNB and all of ETH keep the original monolithic behavior unchanged.
  const ttPartitioned = await isPartitioned('token_transfers')

  const dropIndexes = [
    'DROP INDEX CONCURRENTLY IF EXISTS tx_from_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS tx_to_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS tt_from_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS tt_to_idx',
    // tt_tx_idx is redundant ONLY while the unique (tx_hash, log_index) exists, i.e.
    // on the monolithic table. Post-partition there is no unique → it's the tx-lookup
    // index and must NOT be dropped.
    ...(ttPartitioned ? [] : ['DROP INDEX CONCURRENTLY IF EXISTS tt_tx_idx']),
  ]
  for (const stmt of dropIndexes) {
    try { await db.execute(sql.raw(stmt)) } catch { /* already dropped */ }
  }

  const indexes = buildConcurrentIndexList(ttPartitioned, getChainConfig().whales.nativeIndexFloorWei)

  // When partitioned, create forward partitions BEFORE the indexing loop starts
  // inserting (await, not fire-and-forget) so no insert ever hits a missing range.
  if (ttPartitioned) {
    await ensureForwardPartitions().catch(err =>
      console.warn('[indexer] ensureForwardPartitions warning:', err instanceof Error ? err.message : err))
  }

  // Fire-and-forget: index builds run sequentially after ensureSchema() returns.
  // Sequential (not parallel) to avoid exhausting DB connection slots.
  // The main indexing loop starts immediately; indexes complete in the background.
  ;(async () => {
    for (const idx of indexes) {
      const name = idx.match(/EXISTS (\S+)/)?.[1] ?? '?'
      try {
        await db.execute(sql.raw(idx))
      } catch (err) {
        console.warn(`[indexer] Index build warning (${name}):`, err instanceof Error ? err.message : err)
      }
    }
    if (ttPartitioned) await ensurePartitionedWhaleIndex()
    console.log('[indexer] All indexes ready.')
  })().catch(() => { /* individual errors already logged */ })
}

/**
 * The Whale Tracker's token-side index, as data rather than a literal, because it
 * is emitted from two places that MUST agree: the flat CONCURRENTLY list (used on
 * a monolithic token_transfers) and the partitioned parent/child pair below.
 * `ALTER INDEX ... ATTACH PARTITION` accepts a child only if its definition
 * matches the parent's exactly, so a divergence between the two spellings would
 * not surface until the ATTACH ran against real partitions.
 */
/**
 * Finds invalid indexes left behind by failed CONCURRENTLY builds, so they can be
 * dropped and rebuilt — CREATE INDEX IF NOT EXISTS will not replace an invalid one.
 *
 * `c.relkind = 'i'` is load-bearing and must not be relaxed to a bare
 * `NOT i.indisvalid`. A PARTITIONED index (relkind 'I') is invalid BY DESIGN from
 * the moment it is created ON ONLY until its last partition attaches. Verified on
 * PG16 against a 3-partition token_transfers: without this filter the query
 * returns tt_token_ts_idx both immediately after the parent is created and again
 * with 2 of 3 partitions attached — so any boot landing in that window would drop
 * the parent, taking the children already attached to it. With the filter it
 * returns nothing at either point, and the parent flips valid on the last attach.
 *
 * Leaf children are still swept on purpose: dropping one leaves the parent invalid,
 * which is exactly what ensurePartitionedWhaleIndex() resumes from.
 */
export const INVALID_INDEX_SWEEP_SQL = `
      SELECT c.relname as index_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relkind = 'i'
    `

export const TT_TOKEN_TS_IDX = 'tt_token_ts_idx'
export const TT_TOKEN_TS_COLUMNS = 'token_address, timestamp DESC'

/**
 * The three statements that add TT_TOKEN_TS_IDX to one partition of a partitioned
 * `token_transfers`. Pure, so the guardrail test can assert the exact shipped SQL.
 *
 * The recipe is Postgres's online one, and the split matters:
 *   - the parent is created `ON ONLY`, which is catalog-only and leaves the index
 *     INVALID (and unused by the planner) until every partition is attached;
 *   - each child is built `CONCURRENTLY`, so no partition ever takes a write lock;
 *   - `ATTACH PARTITION` adopts the finished child.
 * The parent flips to valid on its own once the last child is attached. Building
 * the parent WITH recursion instead would lock and rebuild every partition inline,
 * which on BNB is 12 partitions of a table large enough that the whale query was
 * timing out on it.
 */
export function buildPartitionedWhaleIndexSql(partition: string): {
  parent: string
  child: string
  childName: string
  attach: string
} {
  // Derived from the partition name so it is unique per partition and identical
  // across boots — `IF NOT EXISTS` is only idempotent if the name is stable.
  // Partitions are `token_transfers_p_<lo>` (plus `token_transfers_legacy` from
  // the migration), so dropping the shared table prefix keeps names well inside
  // Postgres's 63-byte identifier limit, where a truncated collision would
  // silently attach the wrong child.
  const suffix = partition.startsWith('token_transfers_')
    ? partition.slice('token_transfers_'.length)
    : partition
  const childName = `tt_token_ts_${suffix}`
  return {
    parent: `CREATE INDEX IF NOT EXISTS ${TT_TOKEN_TS_IDX} ON ONLY token_transfers(${TT_TOKEN_TS_COLUMNS})`,
    child: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${childName} ON ${partition}(${TT_TOKEN_TS_COLUMNS})`,
    childName,
    attach: `ALTER INDEX ${TT_TOKEN_TS_IDX} ATTACH PARTITION ${childName}`,
  }
}

/**
 * Full background-build index list. Pure (no DB) so the guardrail test can
 * assert against the exact shipped statements. token_transfers index DDL is
 * skipped when partitioned — the partition migration owns those indexes, and
 * CONCURRENTLY isn't valid on a partitioned parent.
 */
export function buildConcurrentIndexList(
  ttPartitioned: boolean,
  nativeWhaleFloorWei: string,
): string[] {
  // Spliced into DDL, so prove it is a bare integer rather than trusting config.
  if (!/^[0-9]+$/.test(nativeWhaleFloorWei)) {
    throw new Error(
      `buildConcurrentIndexList: native whale floor must be digits, got ${JSON.stringify(nativeWhaleFloorWei)}`,
    )
  }

  const ttIndexes = ttPartitioned ? [] : [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_token_idx            ON token_transfers(token_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_from_ts_idx          ON token_transfers(from_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_to_ts_idx            ON token_transfers(to_address, timestamp DESC)',
    // Whale Tracker token half. Reachable only on the monolithic table —
    // ensurePartitionedWhaleIndex() builds the identical index on BNB, where
    // CONCURRENTLY is rejected on a partitioned parent.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TT_TOKEN_TS_IDX}        ON token_transfers(${TT_TOKEN_TS_COLUMNS})`,
    // tt_tx_idx(tx_hash) intentionally NOT created here — on the monolithic table it's
    // covered by tt_tx_log_unique(tx_hash, log_index) leftmost column.
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_block_idx            ON token_transfers(block_number)',
  ]

  return [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS blocks_miner_idx        ON blocks(miner)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS blocks_timestamp_idx    ON blocks(timestamp)',
    // Composite indexes: cover both point lookups and address+time range queries
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_from_ts_idx          ON transactions(from_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_to_ts_idx            ON transactions(to_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_block_idx            ON transactions(block_number)',
    // A2 body-prune batch scans: retention batches on `block_number < cutoff AND
    // body_pruned = false`. Via the plain tx_block_idx that walk re-visits the
    // ever-growing pruned prefix on every batch — O(prefix × batches) once
    // COMPACT_RETENTION_DAYS > RETENTION_DAYS lets pruned rows persist (root
    // cause of BNB's 1h+ first inversion cycle). This partial index holds only
    // unpruned rows, so each batch walk is bounded by real work and the index
    // shrinks as rows prune. The WHERE spelling must stay exactly
    // `body_pruned = false` — the same fragment pruneTransactionBodies filters
    // on — so the planner can prove the query implies the index predicate.
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_body_unpruned_idx    ON transactions(block_number) WHERE body_pruned = false',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_timestamp_idx        ON transactions(timestamp)',
    // Whale Tracker native half: `timestamp >= cutoff AND value > threshold
    // ORDER BY value DESC LIMIT 25`. No existing index carries `value`, so the
    // planner seq-scans all of `transactions` — measured 37.5s on ETH and past a
    // 60s statement timeout on BNB, against the page's own 15s budget, which is
    // what left /whales serving its error state. `timestamp` leads because it is
    // the selective predicate; being a RANGE scan it does NOT supply the
    // `value DESC` ordering, so a top-N sort still runs. The win is dropping the
    // heap scan, not the sort.
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_ts_value_idx         ON transactions(timestamp DESC, value DESC)',
    // …but dropping the heap SCAN is not dropping the heap FETCHES. The index
    // above still reads every candidate row from the heap to sort it, then
    // throws all but 25 away: 47,692 rows / 23.8s on ETH at 24h, and on BNB
    // 24.8-58.5s at every threshold we can safely set. Raising the threshold
    // does not fix that — under retention-prune I/O the per-row cost swings
    // 3.5-9.4ms, so the total is set by contention, not by the row count.
    //
    // Leading on `value` instead makes the index supply the ORDER BY, so the
    // scan stops at 25 rows and `timestamp` is checked in-index (Index Cond,
    // not Filter — no heap access for rows that fail it). Partial, so it holds
    // only the ~190k rows per chain the page could ever return: 1.2 MB per
    // 29.5k rows measured, ~7.5 MB at prod scale.
    //
    // Verified on PG16 against a fixture built to measured prod selectivity
    // (1.47% of rows above the floor; 24h = 42% of those; 1h = 2%):
    //   tx_ts_value_idx     13,340 rows  14,719 buffers  80.8 ms
    //   tx_whale_value_idx      25 rows      27 buffers   0.16 ms
    //
    // The predicate MUST stay character-identical to
    // `chainConfig.whales.nativeIndexFloorWei`, which the explorer splices into
    // the query as a literal. Postgres only uses a partial index when it can
    // prove the query implies the predicate, and a parameter cannot prove it.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_whale_value_idx      ON transactions(value DESC, timestamp DESC) WHERE value > ${nativeWhaleFloorWei}`,
    ...ttIndexes,
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS logs_address_topic0_idx ON logs(address, topic0)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS logs_tx_idx             ON logs(tx_hash)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS dex_maker_idx           ON dex_trades(maker)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS dex_pair_idx            ON dex_trades(pair_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS dex_block_idx           ON dex_trades(block_number)',
    // Replay safety: what finally lets onConflictDoNothing() dedupe a dex_trade.
    // PARTIAL over rows that carry the key, so rows predating log_index are
    // excluded rather than depended on to be distinct — the build cannot fail on
    // legacy data, so no migration has to run first and there is no state where a
    // failed build wedges the next boot.
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS dex_tx_log_unique ON dex_trades(tx_hash, log_index) WHERE log_index IS NOT NULL',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tb_holder_idx           ON token_balances(holder_address)',
    // Top-N tokens by holders (explorer sitemap top-5000, token directory)
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tokens_holder_count_idx ON tokens(holder_count DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS webhooks_owner_idx      ON webhooks(owner_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS api_keys_owner_idx      ON api_keys(owner_address)',
  ]
}

/**
 * Run `ALTER TABLE ... ADD COLUMN` only if the column is actually missing.
 *
 * `ADD COLUMN IF NOT EXISTS` still takes an AccessExclusiveLock when the column
 * already exists — which stalls the new deploy behind the old instance's
 * ongoing INSERT transactions. Checking pg_attribute first is a cheap read
 * that takes no write lock, so the no-op path is truly free.
 */
async function addColumnIfMissing(table: string, column: string, type: string): Promise<void> {
  const db = getDb()
  const result = await db.execute(sql`
    SELECT 1 FROM pg_attribute
    WHERE attrelid = ${table}::regclass
      AND attname  = ${column}
      AND NOT attisdropped
    LIMIT 1
  `)
  const rows = Array.from(result)
  if (rows.length > 0) return
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`))
}

/** True if `table` is a declaratively-partitioned (RANGE/LIST/HASH) table. */
export async function isPartitioned(table: string): Promise<boolean> {
  const db = getDb()
  const res = await db.execute(sql`
    SELECT 1 FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    WHERE c.relname = ${table}
    LIMIT 1
  `)
  return Array.from(res).length > 0
}

/**
 * List token_transfers RANGE partitions as { name, lo, hi } (block_number bounds),
 * sorted ascending. Skips a DEFAULT partition (no FROM..TO). Used by both forward-
 * partition creation and DROP-PARTITION retention.
 */
export async function listTokenTransferPartitions(
  db: ReturnType<typeof getDb> = getDb(),
): Promise<Array<{ name: string; schema: string; lo: number; hi: number }>> {
  // Return each child's schema (nspname) alongside its name: retention discovers
  // partitions by OID here but DROPs/DELETEs them by name, so it must qualify with
  // the schema from THIS row or search_path could redirect the op (retention O2 P1).
  const res = await db.execute(sql`
    SELECT c.relname AS name, n.nspname AS schema, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = 'token_transfers'::regclass
  `)
  const out: Array<{ name: string; schema: string; lo: number; hi: number }> = []
  for (const row of Array.from(res) as Array<Record<string, unknown>>) {
    const bound = String(row.bound ?? '')
    // e.g. "FOR VALUES FROM ('0') TO ('192000')" or "... FROM (0) TO (192000)"
    const m = bound.match(/FROM \('?(\d+)'?\) TO \('?(\d+)'?\)/)
    if (!m) continue
    out.push({ name: String(row.name), schema: String(row.schema), lo: Number(m[1]), hi: Number(m[2]) })
  }
  return out.sort((a, b) => a.lo - b.lo)
}

/** True if a PARTITIONED index exists and every partition is attached. */
async function partitionedIndexIsValid(name: string): Promise<boolean> {
  const db = getDb()
  const res = await db.execute(sql`
    SELECT i.indisvalid FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = ${name} AND c.relkind = 'I'
    LIMIT 1
  `)
  const row = Array.from(res)[0] as Record<string, unknown> | undefined
  return row?.indisvalid === true
}

/** Child index names already attached to a partitioned index. */
async function listAttachedChildIndexes(parent: string): Promise<Set<string>> {
  const db = getDb()
  const res = await db.execute(sql`
    SELECT c.relname AS name
    FROM pg_inherits inh
    JOIN pg_class c ON c.oid = inh.inhrelid
    JOIN pg_class pc ON pc.oid = inh.inhparent
    WHERE pc.relname = ${parent} AND pc.relkind = 'I'
  `)
  return new Set(Array.from(res).map(r => String((r as Record<string, unknown>).name)))
}

/**
 * Build TT_TOKEN_TS_IDX across a partitioned `token_transfers` (BNB). No-op on a
 * monolithic table, where buildConcurrentIndexList() emits the same index inline.
 *
 * Once the parent index is valid, `CREATE TABLE ... PARTITION OF` gives every
 * future partition a matching child for free — so ensureForwardPartitions() keeps
 * new block ranges covered with no periodic pass here, and the newest partition
 * (the one the 1h/24h whale queries actually read) can never be silently missing
 * the index.
 *
 * Runs in the background after boot: the child builds are CONCURRENTLY over the
 * whole table and are slow, but they never take a write lock.
 */
export async function ensurePartitionedWhaleIndex(): Promise<void> {
  const db = getDb()
  if (!(await isPartitioned('token_transfers'))) return

  // Steady state must cost nothing. A valid parent means every partition is
  // already attached; returning here also keeps CREATE INDEX ON ONLY from
  // reaching for a lock on the parent behind the outgoing deploy generation's
  // in-flight inserts, the same no-op-still-locks trap addColumnIfMissing avoids.
  if (await partitionedIndexIsValid(TT_TOKEN_TS_IDX)) return

  const parts = await listTokenTransferPartitions()
  if (parts.length === 0) return  // migration not run yet — nothing to index

  try {
    await db.execute(sql.raw(buildPartitionedWhaleIndexSql(parts[0].name).parent))
  } catch (err) {
    console.warn(`[indexer] ${TT_TOKEN_TS_IDX} parent create failed:`,
      err instanceof Error ? err.message : err)
    return
  }

  const attached = await listAttachedChildIndexes(TT_TOKEN_TS_IDX)
  let done = 0
  for (const part of parts) {
    const { child, attach, childName } = buildPartitionedWhaleIndexSql(part.name)
    try {
      await db.execute(sql.raw(child))
      if (!attached.has(childName)) await db.execute(sql.raw(attach))
      done++
    } catch (err) {
      // Logged, never swallowed: a partition that fails here leaves the parent
      // invalid, and the next boot resumes from exactly this point.
      console.warn(`[indexer] ${TT_TOKEN_TS_IDX} on ${part.name} failed:`,
        err instanceof Error ? err.message : err)
    }
  }

  // Report the state Postgres actually reached, not the fact that the loop ended.
  // The parent only turns valid when the LAST partition attaches, so a partial
  // run must not read as a completed one.
  const valid = await partitionedIndexIsValid(TT_TOKEN_TS_IDX)
  console.log(`[indexer] ${TT_TOKEN_TS_IDX}: ${done}/${parts.length} partitions indexed, parent valid=${valid}`)
}

/**
 * Ensure token_transfers has empty partitions covering well past where data
 * currently ends, so the writer never hits a missing range. Extends contiguously
 * from the highest existing partition upper-bound in PARTITION_BLOCKS-wide chunks
 * until PARTITION_AHEAD widths beyond MAX(block_number). No-op unless partitioned.
 * Safe to call at boot and on the retention interval.
 */
export async function ensureForwardPartitions(): Promise<void> {
  const db = getDb()
  if (!(await isPartitioned('token_transfers'))) return
  const width = Math.max(1, parseInt(process.env.PARTITION_BLOCKS ?? '192000', 10))   // ~1 day BSC
  const ahead = Math.max(1, parseInt(process.env.PARTITION_AHEAD ?? '7', 10))

  const parts = await listTokenTransferPartitions()
  if (parts.length === 0) return  // migration not run yet — nothing to extend

  let upper = Math.max(...parts.map(p => p.hi))
  const maxRow = await db.execute(sql`SELECT COALESCE(MAX(block_number), 0)::bigint AS m FROM token_transfers`)
  const maxBlock = Number((Array.from(maxRow)[0] as Record<string, unknown>).m) || 0
  const target = maxBlock + ahead * width

  let created = 0
  // Bound the loop generously so a bad config can never spin forever.
  for (let guard = 0; upper <= target && guard < 10_000; guard++) {
    const lo = upper
    const hi = upper + width
    const name = `token_transfers_p_${lo}`
    try {
      await db.execute(sql.raw(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF token_transfers FOR VALUES FROM (${lo}) TO (${hi})`,
      ))
      created++
    } catch (err) {
      console.warn(`[indexer] forward partition ${name} warning:`, err instanceof Error ? err.message : err)
      break
    }
    upper = hi
  }
  if (created > 0) console.log(`[indexer] ensured ${created} forward token_transfers partition(s) up to block ${upper}`)
}
