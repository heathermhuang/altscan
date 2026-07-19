import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMaintenanceConnection, getDb } from '@altscan/db'

/**
 * Behavioral proof for the backfill worker against a REAL Postgres — the
 * string pins in backfill-worker.test.ts cannot prove SKIP LOCKED semantics,
 * lease-clock arithmetic, or transactional atomicity.
 *
 * Gated on BACKFILL_TEST_PG_URL (same variable as the explorer's seam suite,
 * so one throwaway container serves both). Run locally with:
 *
 *   docker run -d --rm --name pg-workertest -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=worker_test -p 127.0.0.1:5441:5432 postgres:16
 *   BACKFILL_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5441/worker_test \
 *     npx vitest run apps/indexer/src/backfill-worker.pg.test.ts
 */
const PG_URL = process.env.BACKFILL_TEST_PG_URL
// FAIL CLOSED: this suite creates and DROPs production-named tables in
// whatever database the URL references. Refuse anything whose database name
// does not contain "test", so a mistyped staging/prod URL cannot lose data.
const DB_NAME = (() => {
  try {
    return PG_URL ? new URL(PG_URL).pathname.replace(/^\//, '') : ''
  } catch {
    return ''
  }
})()
const DISPOSABLE = /test/.test(DB_NAME)
// The worker functions take a Db handle; route a dedicated pooled handle at
// the fixture via getDb's env-var indirection (pool > 1, so the concurrency
// tests race on genuinely separate connections).
if (PG_URL && DISPOSABLE) process.env.BACKFILL_WORKER_TEST_DB = PG_URL

import {
  backfillPressure,
  claimNextEntity,
  processOnePage,
  releaseClaim,
  reservePage,
  type WorkerDb,
} from './backfill-worker'
import { cfg } from './backfill-budget'
import type { ProviderAdapter, ProviderTx, ProviderTokenTransfer } from '@altscan/providers'

const TABLES =
  'backfill_watermarks, backfill_budget, backfill_address_txs, backfill_token_transfers'

describe.skipIf(!PG_URL)('backfill claim — real Postgres', () => {
  const raw = createMaintenanceConnection(PG_URL as string)
  const db = getDb('BACKFILL_WORKER_TEST_DB')

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error(
        `refusing to run: BACKFILL_TEST_PG_URL database "${DB_NAME}" is not disposable — ` +
          `the name must contain "test" (this suite drops production-named tables)`,
      )
    }
    await raw.unsafe(`DROP TABLE IF EXISTS ${TABLES}`)
    // DDL mirrors apps/indexer/src/ensure-schema.ts (the shipped runtime DDL).
    await raw.unsafe(`
      CREATE TABLE backfill_watermarks (
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
      )`)
    await raw.unsafe(`
      CREATE TABLE backfill_budget (
        bucket_hour TIMESTAMPTZ PRIMARY KEY,
        pages_used  INTEGER NOT NULL DEFAULT 0
      )`)
    await raw.unsafe(`
      CREATE TABLE backfill_address_txs (
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
      )`)
    await raw.unsafe(`
      CREATE TABLE backfill_token_transfers (
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
      )`)
  })

  beforeEach(async () => {
    await raw.unsafe(`TRUNCATE ${TABLES}`)
  })

  afterAll(async () => {
    // Runs even when beforeAll threw the disposability error — never DROP on a
    // database we refused to touch.
    if (DISPOSABLE) await raw.unsafe(`DROP TABLE IF EXISTS ${TABLES}`)
    await raw.end({ timeout: 5 })
  })

  /** Seed one watermark row; interval strings offset the clocks from now(). */
  async function seed(over: {
    entity?: string
    status?: string
    attemptAgoSec?: number | null
    createdAgoSec?: number
    rowsWritten?: number
    attempts?: number
  }) {
    const {
      entity = '0x' + 'a'.repeat(40),
      status = 'pending',
      attemptAgoSec = null,
      createdAgoSec = 0,
      rowsWritten = 0,
      attempts = 0,
    } = over
    await raw.unsafe(`
      INSERT INTO backfill_watermarks
        (entity_type, entity_id, status, rows_written, attempts, last_attempt_at, created_at)
      VALUES
        ('address_txs', '${entity}', '${status}', ${rowsWritten}, ${attempts},
         ${attemptAgoSec === null ? 'NULL' : `now() - interval '${attemptAgoSec} seconds'`},
         now() - interval '${createdAgoSec} seconds')`)
  }

  it('returns null on an empty queue', async () => {
    expect(await claimNextEntity(db)).toBeNull()
  })

  it('two concurrent claims yield exactly one winner', async () => {
    await seed({ status: 'pending' })
    const [a, b] = await Promise.all([claimNextEntity(db), claimNextEntity(db)])
    const winners = [a, b].filter(Boolean)
    expect(winners.length).toBe(1)
    expect(winners[0]!.status).toBe('running')
  })

  it('R2: reclaims a running row whose lease has expired, renewing the lease', async () => {
    await seed({ status: 'running', attemptAgoSec: 600 }) // lease is 300s
    const claimed = await claimNextEntity(db)
    expect(claimed).not.toBeNull()
    expect(claimed!.status).toBe('running')
    expect(new Date(claimed!.last_attempt_at as unknown as string).getTime()).toBeGreaterThan(
      Date.now() - 5000,
    )
  })

  it('R2: does NOT reclaim a running row inside its lease', async () => {
    await seed({ status: 'running', attemptAgoSec: 0 })
    expect(await claimNextEntity(db)).toBeNull()
  })

  it('R6: prefers partial over pending even when pending is older and NULL-clocked', async () => {
    await seed({ entity: '0x' + 'b'.repeat(40), status: 'pending', attemptAgoSec: null, createdAgoSec: 3600 })
    await seed({ entity: '0x' + 'c'.repeat(40), status: 'partial', attemptAgoSec: 60, rowsWritten: 50 })
    const claimed = await claimNextEntity(db)
    expect(claimed!.entity_id).toBe('0x' + 'c'.repeat(40))
  })

  it('error rows are not claimable inside their cooldown, and are after it', async () => {
    await seed({ entity: '0x' + 'd'.repeat(40), status: 'error', attempts: 3, attemptAgoSec: 0 })
    expect(await claimNextEntity(db)).toBeNull() // 2^3 = 8s cooldown, 0s elapsed

    await raw.unsafe(`
      UPDATE backfill_watermarks
      SET last_attempt_at = now() - interval '10 seconds'
      WHERE entity_id = '0x${'d'.repeat(40)}'`)
    const claimed = await claimNextEntity(db)
    expect(claimed).not.toBeNull()
    expect(claimed!.entity_id).toBe('0x' + 'd'.repeat(40))
  })

  it('releaseClaim hands a running row back to pending/partial, and only a running row', async () => {
    await seed({ status: 'pending' })
    const claimed = (await claimNextEntity(db))!
    await releaseClaim(db, claimed)
    let [row] = await raw.unsafe(`SELECT status FROM backfill_watermarks WHERE id = ${claimed.id}`)
    expect(row.status).toBe('pending')

    await raw.unsafe(`UPDATE backfill_watermarks SET status = 'complete' WHERE id = ${claimed.id}`)
    await releaseClaim(db, claimed) // guard: must not clobber a non-running status
    ;[row] = await raw.unsafe(`SELECT status FROM backfill_watermarks WHERE id = ${claimed.id}`)
    expect(row.status).toBe('complete')
  })

  // ── Task 2.4: crash-resume + idempotency ──

  const ENTITY = '0x' + 'e'.repeat(40)
  // O1: provider hashes arrive in whatever case the vendor emits; the cache
  // must store them lowercase or the serve path's keyset/exclusion compares break.
  const MIXED_HASHES = ['0xAbC1' + '0'.repeat(60), '0xAbC2' + '0'.repeat(60), '0xAbC3' + '0'.repeat(60)]

  const historyTx = (hash: string, block: number): ProviderTx => ({
    hash,
    blockNumber: String(block),
    blockTimestamp: '2026-07-01T00:00:00.000Z',
    fromAddress: '0xf',
    toAddress: '0xt',
    value: '1',
    gasPrice: '0',
    gasUsed: '0',
    category: 'send',
    summary: 's',
    possibleSpam: false,
    erc20Transfers: [],
  })

  const HISTORY_PAGE = {
    ok: true as const,
    data: {
      txs: [historyTx(MIXED_HASHES[0], 120), historyTx(MIXED_HASHES[1], 119), historyTx(MIXED_HASHES[2], 118)],
      cursor: 'more',
      totalTxs: 3,
    },
  }
  const historyProvider = { kind: 'fake', getAddressHistory: async () => HISTORY_PAGE } as unknown as ProviderAdapter

  /** Wrap the real db so the SECOND statement inside the page transaction (the
   *  watermark UPDATE) throws — modelling a crash between the row insert and
   *  the cursor advance, inside a genuine Postgres transaction. */
  function watermarkThrowingDb(): WorkerDb {
    return {
      execute: db.execute.bind(db),
      transaction: (fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>) =>
        db.transaction((tx) => {
          let calls = 0
          return fn({
            execute: (q: unknown) => {
              if (++calls === 2) throw new Error('injected watermark failure')
              return tx.execute(q as never)
            },
          }) as never
        }),
    } as unknown as WorkerDb
  }

  it('R2: a thrown watermark UPDATE rolls back the rows too — no torn page', async () => {
    await seed({ entity: ENTITY, status: 'pending' })
    const claimed = (await claimNextEntity(db))!

    await expect(processOnePage(watermarkThrowingDb(), historyProvider, claimed)).rejects.toThrow(
      'injected watermark failure',
    )

    const [{ n }] = await raw.unsafe(
      `SELECT count(*)::int AS n FROM backfill_address_txs WHERE address = '${ENTITY}'`,
    )
    expect(n).toBe(0)
    const [wm] = await raw.unsafe(
      `SELECT oldest_cursor, rows_written FROM backfill_watermarks WHERE id = ${claimed.id}`,
    )
    expect(wm.oldest_cursor).toBeNull()
    expect(wm.rows_written).toBe(0)
  })

  it('R2: the re-claimed page then lands exactly once, lowercase, cursor advanced', async () => {
    await seed({ entity: ENTITY, status: 'pending' })
    const claimed = (await claimNextEntity(db))!
    await expect(processOnePage(watermarkThrowingDb(), historyProvider, claimed)).rejects.toThrow()

    // The crashed claim stays 'running' until its lease expires — expire it, re-claim, re-page.
    await raw.unsafe(
      `UPDATE backfill_watermarks SET last_attempt_at = now() - interval '600 seconds' WHERE id = ${claimed.id}`,
    )
    const reclaimed = (await claimNextEntity(db))!
    expect(reclaimed.id).toBe(claimed.id)
    expect(reclaimed.rows_written).toBe(0) // the rollback preserved the pre-crash value

    expect(await processOnePage(db, historyProvider, reclaimed)).toBe('partial')

    const rows = await raw.unsafe(
      `SELECT tx_hash FROM backfill_address_txs WHERE address = '${ENTITY}' ORDER BY tx_hash`,
    )
    expect(rows.map((r: { tx_hash: string }) => r.tx_hash)).toEqual(
      [...MIXED_HASHES].map((h) => h.toLowerCase()).sort(),
    )
    const [wm] = await raw.unsafe(
      `SELECT oldest_cursor, rows_written, backfilled_through_block, status, attempts, last_error
       FROM backfill_watermarks WHERE id = ${claimed.id}`,
    )
    expect(wm.oldest_cursor).toBe('more')
    expect(wm.rows_written).toBe(3)
    expect(Number(wm.backfilled_through_block)).toBe(118)
    expect(wm.status).toBe('partial')
    expect(wm.attempts).toBe(0)
    expect(wm.last_error).toBeNull()
  })

  it('re-paging an identical page dedups on the PK but still advances the cap counter', async () => {
    await seed({ entity: ENTITY, status: 'pending' })
    const claimed = (await claimNextEntity(db))!
    expect(await processOnePage(db, historyProvider, claimed)).toBe('partial')
    const again = { ...claimed, rows_written: 3, oldest_cursor: 'more' }
    expect(await processOnePage(db, historyProvider, again)).toBe('partial')

    const [{ n }] = await raw.unsafe(
      `SELECT count(*)::int AS n FROM backfill_address_txs WHERE address = '${ENTITY}'`,
    )
    expect(n).toBe(3) // PK dedup — not 6
    const [wm] = await raw.unsafe(
      `SELECT rows_written FROM backfill_watermarks WHERE id = ${claimed.id}`,
    )
    expect(wm.rows_written).toBe(6) // intentional: the cap bounds provider WORK, not stored rows
  })

  it('an errored entity recovers through the cooldown to partial on the next good page', async () => {
    await seed({ entity: ENTITY, status: 'error', attempts: 1, attemptAgoSec: 10 }) // 2^1=2s cooldown elapsed
    const claimed = (await claimNextEntity(db))!
    expect(claimed.status).toBe('running')
    expect(await processOnePage(db, historyProvider, claimed)).toBe('partial')
    const [wm] = await raw.unsafe(
      `SELECT status, attempts, last_error FROM backfill_watermarks WHERE id = ${claimed.id}`,
    )
    expect(wm.status).toBe('partial')
    expect(wm.attempts).toBe(0)
    expect(wm.last_error).toBeNull()
  })

  it('O1: transfers pages skip unusable log_index rows and store hashes lowercase', async () => {
    const transfer = (hash: string, logIndex: string | null, block: number): ProviderTokenTransfer => ({
      txHash: hash,
      logIndex,
      blockNumber: String(block),
      blockTimestamp: '2026-07-01T00:00:00.000Z',
      fromAddress: '0xf',
      toAddress: '0xt',
      tokenAddress: '0xtok',
      tokenName: 'T',
      tokenSymbol: 'TKN',
      tokenDecimals: '18',
      value: '5',
      valueFormatted: '0.000005',
    })
    const provider = {
      kind: 'fake',
      getAddressTokenTransfers: async () => ({
        ok: true as const,
        data: {
          transfers: [
            transfer(MIXED_HASHES[0], '292', 120),
            transfer(MIXED_HASHES[0], '289', 120), // same tx, second transfer — the R3 case
            transfer(MIXED_HASHES[1], null, 119), // unusable — skipped, never invented
          ],
          cursor: null,
        },
      }),
    } as unknown as ProviderAdapter

    await raw.unsafe(`
      INSERT INTO backfill_watermarks (entity_type, entity_id, status)
      VALUES ('token_transfers', '${ENTITY}', 'pending')`)
    const claimed = (await claimNextEntity(db))!
    expect(await processOnePage(db, provider, claimed)).toBe('complete')

    const rows = await raw.unsafe(
      `SELECT tx_hash, log_index FROM backfill_token_transfers WHERE scope_address = '${ENTITY}' ORDER BY log_index`,
    )
    expect(rows.map((r: { tx_hash: string; log_index: number }) => [r.tx_hash, r.log_index])).toEqual([
      [MIXED_HASHES[0].toLowerCase(), 289],
      [MIXED_HASHES[0].toLowerCase(), 292],
    ])
    const [wm] = await raw.unsafe(
      `SELECT rows_written, status FROM backfill_watermarks WHERE id = ${claimed.id}`,
    )
    expect(wm.rows_written).toBe(2) // the skipped row is not progress
  })

  // ── Invariant #3 (R4): the budget is only testable against a real counter ──

  it('R4: two concurrent reserves at cap-1 admit exactly one', async () => {
    await raw.unsafe(`
      INSERT INTO backfill_budget (bucket_hour, pages_used)
      VALUES (date_trunc('hour', now()), ${cfg.maxPagesPerHour - 1})`)
    const [a, b] = await Promise.all([reservePage(db), reservePage(db)])
    expect([a, b].filter(Boolean).length).toBe(1)
    const [row] = await raw.unsafe(`SELECT pages_used FROM backfill_budget`)
    expect(row.pages_used).toBe(cfg.maxPagesPerHour)
  })

  it('R4: the first reserve of an hour inserts the bucket at 1', async () => {
    expect(await reservePage(db)).toBe(true)
    const [row] = await raw.unsafe(`SELECT pages_used FROM backfill_budget`)
    expect(row.pages_used).toBe(1)
  })

  it('R5: backfillPressure runs its real query quietly on a tiny database', async () => {
    expect(await backfillPressure(db)).toBeNull()
  })
})
