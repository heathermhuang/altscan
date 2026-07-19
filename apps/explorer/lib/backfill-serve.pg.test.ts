import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMaintenanceConnection } from '@altscan/db'

/**
 * O1 seam behavior against a REAL Postgres — the pure tests pin the codec and
 * carry rules, but only a database can prove the predicate algebra: no skips,
 * no duplicates, pair precision, across MULTIPLE local pages.
 *
 * Gated on BACKFILL_TEST_PG_URL because CI has no Postgres. Run locally with:
 *
 *   docker run -d --rm --name pg-seamtest -e POSTGRES_PASSWORD=x \
 *     -p 127.0.0.1:5440:5432 postgres:16
 *   BACKFILL_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5440/postgres \
 *     npx vitest run lib/backfill-serve.pg.test.ts
 *
 * The fixture reproduces the O1 failure: the provider's within-block order is
 * NOT hash order, so the live page's oldest row is a hash from the MIDDLE of
 * the boundary block. The old tuple-anchored cursor both skipped unseen rows
 * above that hash and re-served seen rows below it.
 */
const PG_URL = process.env.BACKFILL_TEST_PG_URL
// getDb() initializes lazily on first call, so pointing DATABASE_URL at the
// test instance here (before any serve call) routes the SHIPPED functions —
// not a reimplementation — at the fixture. Gated: no-op in CI.
if (PG_URL) process.env.DATABASE_URL = PG_URL

import {
  carrySeamExclusions,
  collectSeenTransferKeys,
  collectSeenTxHashes,
  decodeCursor,
  encodeCursor,
  serveLocalAddressTxs,
  serveLocalTokenTransfers,
  TOP_HASH,
  TOP_LOG_INDEX,
  type ServeCursor,
} from './backfill-serve'

const ADDR = '0x' + 'a'.repeat(40)
const h = (n: number) => '0x' + n.toString(16).padStart(2, '0')

/** Route-faithful cursor round-trip: everything the serve functions receive in
 *  production has passed through encode → decode. */
function roundTrip(c: ServeCursor): Extract<ServeCursor, { source: 'local' }> {
  const out = decodeCursor(encodeCursor(c))
  if (out.source !== 'local') throw new Error(`cursor collapsed to ${out.source}`)
  return out
}

describe.skipIf(!PG_URL)('O1 seam — shipped predicates against real Postgres', () => {
  const sql = createMaintenanceConnection(PG_URL as string)

  // Boundary block 100 holds 30 cached rows (hashes 0x01..0x1e). The live page
  // served three of them — in PROVIDER order [0x1e, 0x02, 0x10], so the page's
  // oldest row is 0x10, a hash from the middle of the block.
  const BLOCK100 = Array.from({ length: 30 }, (_, i) => h(i + 1))
  const SEEN = [h(30), h(2), h(16)] // 0x1e, 0x02, 0x10 — provider order
  const OLDEST = h(16)

  beforeAll(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS backfill_address_txs, backfill_token_transfers`)
    await sql.unsafe(`
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
    await sql.unsafe(`
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
    const insert = async (hash: string, block: number) =>
      sql.unsafe(
        `INSERT INTO backfill_address_txs
         (address, tx_hash, block_number, block_timestamp, from_address, value, category, summary)
         VALUES ('${ADDR}', '${hash}', ${block}, now(), '${ADDR}', 1, 'send', 's')`,
      )
    for (const hash of BLOCK100) await insert(hash, 100)
    for (const hash of [h(0x51), h(0x52), h(0x53)]) await insert(hash, 99)
    for (const hash of [h(0x61), h(0x62)]) await insert(hash, 98)

    const insertT = async (hash: string, idx: number, block: number) =>
      sql.unsafe(
        `INSERT INTO backfill_token_transfers
         (scope_address, tx_hash, log_index, token_address, from_address, to_address, value, block_number, block_timestamp)
         VALUES ('${ADDR}', '${hash}', ${idx}, '${ADDR}', '${ADDR}', '${ADDR}', 1, ${block}, now())`,
      )
    await insertT('0xaa', 1, 100)
    await insertT('0xaa', 2, 100)
    await insertT('0xaa', 3, 100)
    await insertT('0xbb', 0, 100)
    await insertT('0xcc', 5, 99)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS backfill_address_txs, backfill_token_transfers`)
    await sql.end({ timeout: 5 })
  })

  it('the OLD tuple anchor demonstrably skips and duplicates at the seam', async () => {
    // Anchor at the live page's oldest row, as the pre-O1 code did.
    const old = roundTrip({ source: 'local', blockNumber: 100, txHash: OLDEST })
    const { rows } = await serveLocalAddressTxs(ADDR, old)
    const hashes = rows.map(r => r.hash)
    // Re-serves 0x02 — the provider already showed it on page 1 (duplicate)…
    expect(hashes).toContain(h(2))
    // …and can never serve 0x11..0x1d — unseen rows above the anchor (skip).
    expect(hashes).not.toContain(h(17))
  })

  it('the seen-hash handoff serves EXACTLY the complement, across pages, in order', async () => {
    const seen = collectSeenTxHashes(
      SEEN.map(hash => ({ hash, blockNumber: '100' })) as never[],
      100,
    )
    let cur = roundTrip({
      source: 'local', blockNumber: 100, txHash: TOP_HASH,
      boundaryBlock: 100, seenTxHashes: seen,
    })

    const served: string[] = []
    for (let guard = 0; guard < 10; guard++) {
      const { rows, lastBoundary, hasMore } = await serveLocalAddressTxs(ADDR, cur)
      served.push(...rows.map(r => r.hash))
      if (!hasMore || !lastBoundary) break
      // Exactly the route's re-mint, through the codec.
      cur = roundTrip({
        source: 'local',
        ...lastBoundary,
        ...carrySeamExclusions(cur, lastBoundary.blockNumber),
      })
    }

    const expected = [
      ...BLOCK100.filter(hash => !SEEN.includes(hash)).sort().reverse(),
      h(0x53), h(0x52), h(0x51),
      h(0x62), h(0x61),
    ]
    // No skips, no duplicates, strict (block, hash) DESC — page 1 ends inside
    // the boundary block, so this passes ONLY if the exclusions rode the
    // second cursor; dropping the carry re-serves 0x02 as a duplicate.
    expect(served).toEqual(expected)
  })

  it('transfer exclusion is pair-precise: unseen siblings of a seen transfer survive', async () => {
    const seenKeys = collectSeenTransferKeys(
      [
        { blockNumber: '100', txHash: '0xAA', logIndex: '2' },
        { blockNumber: '100', txHash: '0xbb', logIndex: '0' },
      ] as never[],
      100,
    )
    const cur = roundTrip({
      source: 'local', blockNumber: 100, txHash: TOP_HASH, logIndex: TOP_LOG_INDEX,
      boundaryBlock: 100, seenTransferKeys: seenKeys,
    })
    const { rows } = await serveLocalTokenTransfers(ADDR, cur)
    const keys = rows.map(r => `${r.txHash}:${r.logIndex}`)
    // (0xaa,2) and (0xbb,0) were on the live page — excluded. (0xaa,1) and
    // (0xaa,3) were NOT — a hash-only exclusion would have dropped them too.
    expect(keys).toEqual(['0xaa:3', '0xaa:1', '0xcc:5'])
  })
})
