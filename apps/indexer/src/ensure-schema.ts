/**
 * Idempotent schema bootstrap for BNB Chain indexer.
 * Creates all tables and indexes using IF NOT EXISTS so it is safe
 * to call on every startup — either a fresh DB or an existing one.
 */
import { getDb } from './db'
import { sql } from 'drizzle-orm'

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
      balance     NUMERIC(36,18) NOT NULL DEFAULT 0,
      tx_count    INTEGER NOT NULL DEFAULT 0,
      is_contract BOOLEAN NOT NULL DEFAULT false,
      label       VARCHAR(255),
      first_seen  TIMESTAMPTZ,
      last_seen   TIMESTAMPTZ
    )
  `))

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS token_transfers (
      id            SERIAL PRIMARY KEY,
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

  // Column migrations — idempotent ADD COLUMN IF NOT EXISTS for schema evolution
  await db.execute(sql.raw(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS nonce INTEGER`))
  await db.execute(sql.raw(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_type INTEGER`))
  await db.execute(sql.raw(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo_url TEXT`))

  // Drop any invalid indexes left behind by failed CONCURRENTLY builds.
  // CREATE INDEX IF NOT EXISTS won't replace an invalid index, so we must drop first.
  try {
    const invalid = await db.execute(sql.raw(`
      SELECT c.relname as index_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid
    `))
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
  // Drop redundant single-column indexes — composite (address, timestamp) indexes cover these.
  // Each saves ~2-4GB on 10M+ row tables.
  const dropIndexes = [
    'DROP INDEX CONCURRENTLY IF EXISTS tx_from_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS tx_to_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS tt_from_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS tt_to_idx',
  ]
  for (const stmt of dropIndexes) {
    try { await db.execute(sql.raw(stmt)) } catch { /* already dropped */ }
  }

  const indexes = [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS blocks_miner_idx        ON blocks(miner)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS blocks_timestamp_idx    ON blocks(timestamp)',
    // Composite indexes: cover both point lookups and address+time range queries
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_from_ts_idx          ON transactions(from_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_to_ts_idx            ON transactions(to_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_block_idx            ON transactions(block_number)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_timestamp_idx        ON transactions(timestamp)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_token_idx            ON token_transfers(token_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_from_ts_idx          ON token_transfers(from_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_to_ts_idx            ON token_transfers(to_address, timestamp DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_tx_idx               ON token_transfers(tx_hash)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_block_idx            ON token_transfers(block_number)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS logs_address_topic0_idx ON logs(address, topic0)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS logs_tx_idx             ON logs(tx_hash)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS dex_maker_idx           ON dex_trades(maker)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS dex_pair_idx            ON dex_trades(pair_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS dex_block_idx           ON dex_trades(block_number)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tb_holder_idx           ON token_balances(holder_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS webhooks_owner_idx      ON webhooks(owner_address)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS api_keys_owner_idx      ON api_keys(owner_address)',
  ]

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
    console.log('[indexer] All indexes ready.')
  })().catch(() => { /* individual errors already logged */ })
}
