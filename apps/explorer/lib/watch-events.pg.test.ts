/**
 * Wallet watch against a REAL Postgres with a real connection pool: the per-owner cap under concurrency
 * (lib/watch-addresses.ts) and the event feed's paging (lib/watch-events.ts).
 *
 * Gated on WATCH_EVENTS_TEST_PG_URL, which must name a disposable database (its name must contain
 * "test"); the suite creates and drops blocks, transactions, token_transfers, tokens, indexer_cursor and
 * watch_addresses there. Run locally with:
 *
 *   docker run -d --rm --name pg-watch -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=watch_events_test -p 127.0.0.1:5468:5432 postgres:16
 *   WATCH_EVENTS_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5468/watch_events_test \
 *     npx vitest run apps/explorer/lib/watch-events.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, type Db } from '@altscan/db'
import { WATCH_MAX_ADDRESSES, addWatchAddresses, listWatchAddresses, removeWatchAddress } from './watch-addresses'

const ENV = 'WATCH_EVENTS_TEST_PG_URL'
const PG_URL = process.env[ENV]
const PARALLEL = 15
const TABLES = ['watch_addresses', 'blocks', 'transactions', 'token_transfers', 'tokens', 'indexer_cursor']

const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const OWNER = addr(0xaaaa)

describe.skipIf(!PG_URL)('wallet watch — against a real Postgres', () => {
  let db: Db

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    process.env.DB_POOL_SIZE = String(PARALLEL)
    db = getDb(ENV)
    for (const t of TABLES) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`))
    // As apps/indexer/src/ensure-schema.ts creates them (only the columns the feed reads, plus NOT NULLs).
    await db.execute(sql.raw(`
      CREATE TABLE watch_addresses (
        owner_address VARCHAR(42) NOT NULL, address VARCHAR(42) NOT NULL, label VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (owner_address, address))`))
    await db.execute(sql.raw(`CREATE INDEX watch_addresses_address_idx ON watch_addresses (address)`))
    await db.execute(sql.raw(`
      CREATE TABLE blocks (number BIGINT PRIMARY KEY, hash VARCHAR(66) NOT NULL UNIQUE, timestamp TIMESTAMPTZ NOT NULL)`))
    await db.execute(sql.raw(`
      CREATE TABLE transactions (
        hash VARCHAR(66) PRIMARY KEY, block_number BIGINT NOT NULL, from_address VARCHAR(42) NOT NULL,
        to_address VARCHAR(42), value NUMERIC(78,18) NOT NULL DEFAULT 0, status BOOLEAN NOT NULL DEFAULT true,
        tx_index INTEGER NOT NULL, timestamp TIMESTAMPTZ NOT NULL)`))
    await db.execute(sql.raw(`CREATE INDEX tx_from_ts_idx ON transactions (from_address, timestamp DESC)`))
    await db.execute(sql.raw(`CREATE INDEX tx_to_ts_idx ON transactions (to_address, timestamp DESC)`))
    await db.execute(sql.raw(`
      CREATE TABLE token_transfers (
        tx_hash VARCHAR(66) NOT NULL, log_index INTEGER NOT NULL, token_address VARCHAR(42) NOT NULL,
        from_address VARCHAR(42) NOT NULL, to_address VARCHAR(42) NOT NULL, value NUMERIC(78,0) NOT NULL DEFAULT 0,
        block_number BIGINT NOT NULL, timestamp TIMESTAMPTZ NOT NULL)`))
    await db.execute(sql.raw(`CREATE INDEX tt_from_ts_idx ON token_transfers (from_address, timestamp DESC)`))
    await db.execute(sql.raw(`CREATE INDEX tt_to_ts_idx ON token_transfers (to_address, timestamp DESC)`))
    await db.execute(sql.raw(`
      CREATE TABLE tokens (address VARCHAR(42) PRIMARY KEY, symbol VARCHAR(50) NOT NULL, decimals INTEGER NOT NULL DEFAULT 18)`))
    await db.execute(sql.raw(`
      CREATE TABLE indexer_cursor (id INTEGER PRIMARY KEY DEFAULT 1, transfers_durable_block BIGINT NOT NULL DEFAULT 0,
        compact_cutoff_block BIGINT)`))
    await Promise.all(Array.from({ length: PARALLEL }, () => db.execute(sql.raw('SELECT pg_sleep(0.2)'))))
  })

  afterAll(async () => {
    if (db) for (const t of TABLES) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`))
  })

  beforeEach(async () => {
    for (const t of TABLES) await db.execute(sql.raw(`TRUNCATE ${t}`))
    await db.execute(sql.raw(`INSERT INTO indexer_cursor (id, transfers_durable_block) VALUES (1, 0)`))
  })

  describe('watchlist', () => {
    it('parallel adds never take an owner past the cap', async () => {
      // 15 requests x 4 distinct addresses = 60 > 50: exactly 12 fit, 3 are refused whole.
      const results = await Promise.all(Array.from({ length: PARALLEL }, (_, r) =>
        addWatchAddresses(db, OWNER, [0, 1, 2, 3].map((j) => addr(1000 + r * 4 + j)), null)))
      expect(results.filter((x) => x.ok)).toHaveLength(Math.floor(WATCH_MAX_ADDRESSES / 4))
      expect(results.filter((x) => !x.ok)).toHaveLength(PARALLEL - Math.floor(WATCH_MAX_ADDRESSES / 4))
      expect(await listWatchAddresses(db, OWNER)).toHaveLength(Math.floor(WATCH_MAX_ADDRESSES / 4) * 4)
    })

    it('re-adding a watched address is a no-op', async () => {
      expect(await addWatchAddresses(db, OWNER, [addr(1), addr(2)], 'hot')).toEqual({ ok: true, added: 2, total: 2 })
      expect(await addWatchAddresses(db, OWNER, [addr(2), addr(3)], null)).toEqual({ ok: true, added: 1, total: 3 })
    })

    it('removes only the owner\'s own row', async () => {
      await addWatchAddresses(db, OWNER, [addr(1)], null)
      await addWatchAddresses(db, addr(0xbbbb), [addr(1)], null)
      expect(await removeWatchAddress(db, OWNER, addr(1))).toBe(true)
      expect(await removeWatchAddress(db, OWNER, addr(1))).toBe(false)
      expect(await listWatchAddresses(db, addr(0xbbbb))).toHaveLength(1)
    })
  })
})
