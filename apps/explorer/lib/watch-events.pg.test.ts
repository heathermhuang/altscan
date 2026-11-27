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
import { END_OF_BLOCK, decodeWatchCursor, encodeWatchCursor } from './watch-cursor'
import { WATCH_REWIND_BLOCKS, readWatchEvents, type WatchFeed } from './watch-events'
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

  describe('feed', () => {
    const T0 = Date.parse('2026-11-15T00:00:00Z')
    const hashOf = (n: number, salt = 0) => '0x' + (n + salt * 1_000_000).toString(16).padStart(64, '0')
    const txh = (n: number) => '0x' + (0xf000000 + n).toString(16).padStart(64, '0')
    const A = addr(0xa1), B = addr(0xb1), X = addr(0xc1), USDT = addr(0x55)
    const at = (b: number) => encodeWatchCursor({ b, h: hashOf(b), k: END_OF_BLOCK, i: 0, w: '' })

    const seedBlocks = (from: number, to: number) => db.execute(sql`
      INSERT INTO blocks (number, hash, timestamp)
      SELECT n, '0x' || lpad(to_hex(n), 64, '0'), to_timestamp(${T0 / 1000} + n)
        FROM generate_series(${from}::bigint, ${to}::bigint) n`)
    const durable = (b: number) => db.execute(sql`UPDATE indexer_cursor SET transfers_durable_block = ${b}`)
    const nativeTx = (n: number, block: number, idx: number, from: string, to: string | null, value: string, status = true) =>
      db.execute(sql`INSERT INTO transactions (hash, block_number, from_address, to_address, value, status, tx_index, timestamp)
        VALUES (${txh(n)}, ${block}, ${from}, ${to}, ${value}, ${status}, ${idx}, to_timestamp(${T0 / 1000 + block}))`)
    const tokenTx = (n: number, block: number, log: number, from: string, to: string, value: string) =>
      db.execute(sql`INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, value, block_number, timestamp)
        VALUES (${txh(n)}, ${log}, ${USDT}, ${from}, ${to}, ${value}, ${block}, to_timestamp(${T0 / 1000 + block}))`)
    const ok = (p: Awaited<ReturnType<typeof readWatchEvents>>): WatchFeed => {
      if (p.status !== 'ok') throw new Error(`expected ok, got ${p.status}`)
      return p.body
    }
    const drain = async (start: string, limit: number) => {
      const seen: string[] = []
      let cursor = start
      for (let guard = 0; guard < 50; guard++) {
        const page = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(cursor), limit))
        seen.push(...page.events.map((e) => `${e.blockNumber}:${e.type}:${e.direction}:${e.watched === A ? 'A' : 'B'}`))
        if (page.cursor === cursor) break
        cursor = page.cursor
        if (page.events.length === 0 && decodeWatchCursor(cursor)!.b >= page.tip) break
      }
      return seen
    }

    beforeEach(async () => {
      await addWatchAddresses(db, OWNER, [A, B], null)
      await db.execute(sql`INSERT INTO tokens (address, symbol, decimals) VALUES (${USDT}, 'USDT', 18)`)
    })

    it('is not ready until a durable block exists', async () => {
      expect((await readWatchEvents(db, OWNER, null, 100)).status).toBe('not_ready')
    })

    it('starts at the durable tip with no backlog, never past it', async () => {
      await seedBlocks(1, 30)
      await durable(20)
      await nativeTx(1, 10, 0, A, X, '5.000000000000000000')
      const first = ok(await readWatchEvents(db, OWNER, null, 100))
      expect(first.events).toEqual([])
      expect(first.tip).toBe(20)
      expect(decodeWatchCursor(first.cursor)).toMatchObject({ b: 20, k: END_OF_BLOCK })
    })

    it('pages through every matching transfer exactly once, in chain order', async () => {
      await seedBlocks(1, 30)
      await durable(30)
      await nativeTx(1, 5, 0, A, X, '1000000000000000000.000000000000000000')        // A out
      await nativeTx(2, 5, 1, A, X, '0.000000000000000000')                         // zero value: excluded
      await nativeTx(3, 6, 0, A, X, '7.000000000000000000', false)                  // failed: excluded
      await tokenTx(4, 6, 2, X, B, '42')                                            // B in
      await tokenTx(5, 7, 0, A, B, '9')                                             // A out AND B in
      await tokenTx(6, 8, 1, B, B, '3')                                             // B self, once
      await tokenTx(7, 9, 0, X, addr(0xd1), '1')                                    // unwatched: excluded
      await nativeTx(8, 25, 4, X, A, '2.000000000000000000')                        // A in
      const expected = ['5:native:out:A', '6:token:in:B', '7:token:out:A', '7:token:in:B', '8:token:self:B', '25:native:in:A']
      for (const limit of [1, 2, 100]) expect(await drain(at(1), limit)).toEqual(expected)
    })

    it('serves a block only once the transfer writer has made it durable', async () => {
      await seedBlocks(1, 30)
      await durable(20)
      await tokenTx(1, 25, 0, X, A, '1')
      const before = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(at(1)), 100))
      expect(before.events).toEqual([])
      expect(decodeWatchCursor(before.cursor)!.b).toBe(20)
      await durable(30)
      const after = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(before.cursor), 100))
      expect(after.events.map((e) => e.blockNumber)).toEqual([25])
    })

    it('scans at most WATCH_WINDOW_BLOCKS blocks per call', async () => {
      await seedBlocks(1, 3000)
      await durable(3000)
      await tokenTx(1, 2500, 0, X, A, '1')
      const p1 = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(at(1)), 100))
      expect(p1.events).toEqual([])
      expect(decodeWatchCursor(p1.cursor)!.b).toBe(1200)
      const p2 = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(p1.cursor), 100))
      expect(decodeWatchCursor(p2.cursor)!.b).toBe(2399)
      const p3 = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(p2.cursor), 100))
      expect(p3.events.map((e) => e.blockNumber)).toEqual([2500])
    })

    it('answers gone for a cursor older than the retained window', async () => {
      await seedBlocks(10, 30)
      await durable(30)
      await db.execute(sql`UPDATE indexer_cursor SET compact_cutoff_block = 10`)
      expect(await readWatchEvents(db, OWNER, decodeWatchCursor(at(5)), 100)).toEqual({ status: 'gone', oldestAvailableBlock: 10 })
    })

    it('rewinds when the cursor\'s block was replaced by a reorg', async () => {
      await seedBlocks(1, 30)
      await durable(30)
      const cursor = at(20)
      await db.execute(sql`UPDATE blocks SET hash = ${hashOf(20, 1)} WHERE number = 20`)
      await tokenTx(1, 20 - WATCH_REWIND_BLOCKS + 3, 0, X, A, '1')
      const page = ok(await readWatchEvents(db, OWNER, decodeWatchCursor(cursor), 100))
      expect(page.rewound).toBe(true)
      expect(page.events.map((e) => e.blockNumber)).toEqual([20 - WATCH_REWIND_BLOCKS + 3])
    })
  })
})
