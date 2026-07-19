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

import { claimNextEntity } from './backfill-worker'

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
})
