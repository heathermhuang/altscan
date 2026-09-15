import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createMaintenanceConnection, schema } from '@altscan/db'
import { selectTokenTransfers, TOKEN_TRANSFERS_MAX_ROWS } from './token-transfers-query'

/**
 * The token page's transfer list against a REAL Postgres.
 *
 * `token_address = $1 ORDER BY block_number DESC LIMIT 25` has no index that
 * serves both the filter and the order, so the planner walks the block_number
 * index from the tip and filters every row until 25 match. For a token that was
 * busy and has gone quiet, that is every transfer since its last one. On BNB it
 * hit the web's 15s statement_timeout 34 times between 2026-09-13 20:00 and
 * 2026-09-14 02:40 UTC and ran 2-15s another 154 times, on 131 distinct tokens
 * at offsets of 0-2075. The page gives up after 6s and renders "No transfers
 * yet."; the query keeps its pool connection until the server cancels it.
 *
 * Gated on TOKEN_TRANSFERS_TEST_PG_URL. The tables are TEMP on one non-recycled
 * connection per shape, so the suite cannot collide with another that shares
 * the database. The DDL mirrors the indexes ensure-schema.ts creates in prod:
 * BNB's token_transfers is RANGE-partitioned by block_number and ETH's is a
 * plain table, and they get different plans.
 */
const ENV = 'TOKEN_TRANSFERS_TEST_PG_URL'
const PG_URL = process.env[ENV]

const MEGA = '0x' + 'a1'.repeat(20)     // four transfers in every block
const QUIET = '0x' + 'a2'.repeat(20)    // two a block in the OLDEST partition, none since
const SPREAD = '0x' + 'a3'.repeat(20)   // one a block, in pairs of blocks that share a second

// 10,000 blocks of 0.75s, truncated to whole seconds as on BNB, so consecutive
// blocks share a timestamp. Partitioned, that is 4 partitions of 2,500 blocks.
const TS = `timestamptz '2026-09-12 00:00:00+00' + floor(b * 0.75) * interval '1 second'`
const h = (salt: number, n: number) => `((hashint4(b * 64 + i + ${salt})::bigint + 2147483648) % ${n})`

const COLUMNS = `
  tx_hash VARCHAR(66) NOT NULL, log_index INTEGER NOT NULL DEFAULT 0,
  token_address VARCHAR(42) NOT NULL, from_address VARCHAR(42) NOT NULL, to_address VARCHAR(42) NOT NULL,
  value NUMERIC(78,0) NOT NULL DEFAULT 0, token_id NUMERIC(78,0),
  block_number BIGINT NOT NULL, timestamp TIMESTAMPTZ NOT NULL`

const SHAPES = [
  {
    chain: 'BNB, partitioned',
    table: `
      CREATE TEMP TABLE token_transfers (${COLUMNS}) PARTITION BY RANGE (block_number);
      CREATE TEMP TABLE token_transfers_p_0    PARTITION OF token_transfers FOR VALUES FROM (0)    TO (2500);
      CREATE TEMP TABLE token_transfers_p_2500 PARTITION OF token_transfers FOR VALUES FROM (2500) TO (5000);
      CREATE TEMP TABLE token_transfers_p_5000 PARTITION OF token_transfers FOR VALUES FROM (5000) TO (7500);
      CREATE TEMP TABLE token_transfers_p_7500 PARTITION OF token_transfers FOR VALUES FROM (7500) TO (10000);`,
  },
  { chain: 'ETH, plain table', table: `CREATE TEMP TABLE token_transfers (${COLUMNS});` },
]

const ROWS = `
  -- 10 a block: 3 in 10 from five hot tokens, the rest from a tail of 5,000.
  INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, block_number, timestamp)
  SELECT '0x' || md5('t' || b || ':' || i) || md5('u' || b || ':' || i), i,
         CASE WHEN ${h(1, 10)} < 3 THEN '0x' || md5('hot' || ${h(2, 5)}) || '00000000'
              ELSE '0x' || md5('tail' || ${h(3, 5000)}) || '00000000' END,
         '0x' || md5('f' || b || ':' || i) || '00000000', '0x' || md5('g' || b || ':' || i) || '00000000', b, ${TS}
  FROM generate_series(0, 9999) b, generate_series(0, 9) i;

  INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, block_number, timestamp)
  SELECT '0x' || md5(token || b || ':' || i) || md5('v' || b || ':' || i), 100 + i, token,
         '0x' || md5('p' || b || ':' || i) || '00000000', '0x' || md5('q' || b || ':' || i) || '00000000', b, ${TS}
  FROM (SELECT '${MEGA}' AS token, b, i FROM generate_series(0, 9999) b, generate_series(0, 3) i
        UNION ALL SELECT '${QUIET}', b, i FROM generate_series(0, 2499) b, generate_series(0, 1) i
        UNION ALL SELECT '${SPREAD}', b, 0 FROM (SELECT generate_series(0, 9999, 64) AS b
                                                 UNION ALL SELECT generate_series(0, 9999, 64) + 1) s) t;

  CREATE INDEX ON token_transfers (token_address);
  CREATE INDEX ON token_transfers (from_address, timestamp DESC);
  CREATE INDEX ON token_transfers (to_address, timestamp DESC);
  CREATE INDEX ON token_transfers (token_address, timestamp DESC);
  CREATE INDEX ON token_transfers (block_number);
  CREATE INDEX ON token_transfers (tx_hash);
  ANALYZE token_transfers;
`

type PlanNode = {
  'Node Type': string
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  'Rows Removed by Index Recheck'?: number
  Plans?: PlanNode[]
}

/** Heap rows the executor visited: returned by a scan, or read and discarded by its filter. */
function rowsRead(node: PlanNode): number {
  const scan = /Scan$/.test(node['Node Type']) && node['Node Type'] !== 'Bitmap Index Scan'
  const own = scan
    ? (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops']
    : 0
  return (node.Plans ?? []).reduce((n, child) => n + rowsRead(child), own)
}

const key = (r: { txHash: string; logIndex: number }) => `${r.txHash}:${r.logIndex}`

describe.skipIf(!PG_URL)('token page transfers — against a real Postgres', () => {
  describe.each(SHAPES)('$chain', ({ table }) => {
    let conn: ReturnType<typeof createMaintenanceConnection>
    let db: ReturnType<typeof drizzle<typeof schema>>

    beforeAll(async () => {
      if (!/test/i.test(new URL(PG_URL as string).pathname)) {
        throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
      }
      conn = createMaintenanceConnection(PG_URL as string)
      db = drizzle(conn, { schema })
      await conn.unsafe(table + ROWS)
    }, 120_000)

    afterAll(async () => {
      await conn?.end({ timeout: 5 })
    })

    async function rowsReadBy(q: { toSQL(): { sql: string; params: unknown[] } }) {
      const { sql: text, params } = q.toSQL()
      const [{ 'QUERY PLAN': [explained] }] = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as never[])
      return rowsRead(explained.Plan)
    }

    // Pages 1 and 2 are what prod hit. The last page served must not fall back
    // to reading every transfer of the token (MEGA has four times as many).
    it.each([
      ['a token that has gone quiet', 0, QUIET],
      ['a token that has gone quiet', 25, QUIET],
      ['a token busy in every block', 0, MEGA],
      ['a token busy in every block', 25, MEGA],
      ['a token busy in every block', TOKEN_TRANSFERS_MAX_ROWS - 25, MEGA],
    ])('reads O(offset + limit) rows for %s at offset %i, not the table', async (_, offset, token) => {
      const q = selectTokenTransfers(db, token, { limit: 25, offset })
      expect(await q).toHaveLength(25)
      // At least the rows it steps over, so a plan this walker cannot read fails loudly.
      const read = await rowsReadBy(q)
      expect(read).toBeGreaterThanOrEqual(offset + 25)
      expect(read).toBeLessThan(offset + 25 + 50)
    })

    it('returns the rows ORDER BY block_number returned, for every limit and offset', async () => {
      const byBlock = (token: string, limit: number, offset: number) => db.select().from(schema.tokenTransfers)
        .where(eq(schema.tokenTransfers.tokenAddress, token))
        .orderBy(desc(schema.tokenTransfers.blockNumber))
        .limit(limit)
        .offset(offset)
      for (const limit of [1, 7, 25]) {
        for (const offset of [0, 5, 25, 300, 400]) {
          const label = `limit=${limit} offset=${offset}`
          // One transfer a block, so block order ranks every row.
          expect((await selectTokenTransfers(db, SPREAD, { limit, offset })).map(key), label)
            .toEqual((await byBlock(SPREAD, limit, offset)).map(key))
          // Four a block, which neither order ranks among themselves, so compare the blocks.
          expect((await selectTokenTransfers(db, MEGA, { limit, offset })).map(r => r.blockNumber), label)
            .toEqual((await byBlock(MEGA, limit, offset)).map(r => r.blockNumber))
        }
      }
    })
  })
})
