import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createMaintenanceConnection } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'
import { buildTokenWhaleQuery, rankWhalesByUsd, type WhalePeriod, type WhaleTx } from '@/lib/whales'

/**
 * /whales' token candidates against a REAL Postgres, on BOTH production table shapes: ETH's monolithic
 * `token_transfers` and BNB's range-partitioned one.
 *
 * The token half used to take each tracked token's newest 25 transfers, because `token_transfers` had no
 * index on `value` and value-ordered reads took 10 s to 6 min. Production now has ONE combined partial
 * index per chain, `tt_whale_idx ON token_transfers (token_address, value DESC)`, predicated on
 * `(token_address = '<a>' AND value > <floor>)` for each tracked token, so each token also contributes its
 * 25 LARGEST whale-size transfers. What the unit tests cannot show, this does:
 *   - the whale arm is actually served by that index (on every partition), for every tracked token, in
 *     the windows where an index walk is the right plan. Lose a literal and nothing errors: the page just
 *     gets 10-600x slower again;
 *   - the failure mode is real: the same arm with the token and floor as BOUND parameters, planned
 *     generically, does not use the index (so the assertion above is capable of failing);
 *   - the point of the change: a $1M stablecoin transfer older than the newest 25 qualifying ones is now a
 *     candidate, and outranks the recent small ones;
 *   - a transfer that qualifies for both arms comes out once;
 *   - the index-served rows, order included, are what a sequential scan returns.
 *
 * Gated on WHALES_TEST_PG_URL. The tables are TEMP on a single non-recycled connection, so the suite
 * cannot collide with another that shares the database. The index DDL mirrors ensure-schema.ts's
 * `ttWhaleIndex` (`token_address, value DESC`, one OR-ed arm per tracked token, built from the same
 * chain-config `indexFloor`); apps/indexer/src/tt-whale-index.pg.test.ts pins the shipped statement.
 * Run locally with:
 *
 *   docker run -d --rm --name pg-whales -e POSTGRES_PASSWORD=x -e POSTGRES_DB=whales_test \
 *     -p 127.0.0.1:5468:5432 postgres:16
 *   WHALES_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5468/whales_test \
 *     npx vitest run apps/explorer/lib/whales.pg.test.ts
 */
const ENV = 'WHALES_TEST_PG_URL'
const PG_URL = process.env[ENV]

const dialect = new PgDialect()

type PlanNode = {
  'Node Type': string
  'Index Name'?: string
  'Relation Name'?: string
  Plans?: PlanNode[]
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)]
const shape = (nodes: PlanNode[]) =>
  nodes.map(n => n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `[${n['Relation Name']}]` : '')).join(' > ')

/** Noise rows spread over three days, ending now: 120,000 at 2.16 s apart. */
const NOISE = 120_000
const hash = (c: string) => `0x${c.repeat(64)}`
const BIG_OLD = hash('a')      // $1,000,000, 20 h ago: older than the newest 25 qualifying transfers
const MID_OLD = hash('b')      // $50,000, 10 h ago: above the display threshold, below the whale floor
const BIG_RECENT = hash('c')   // $500,000, 30 s ago: in BOTH arms
const NEWEST_MID = 40          // $2,000 transfers, 1..40 minutes ago: they fill the latest arm and keep BIG_OLD out of it

const SHAPES = [
  { chain: 'eth', partitioned: false, partitions: 1 },
  { chain: 'bnb', partitioned: true, partitions: 3 },
] as const

describe.skipIf(!PG_URL)('whale token candidates — against a real Postgres', () => {
  const conn = createMaintenanceConnection(PG_URL as string)

  const rows = async (q: string): Promise<Record<string, unknown>[]> => Array.from(await conn.unsafe(q))

  afterAll(async () => {
    await conn.end({ timeout: 5 })
  })

  describe.each(SHAPES)('$chain: partitioned=$partitioned', ({ chain, partitioned, partitions }) => {
    const whales = getChainConfig(chain).whales
    const tracked = [whales.wrapped, ...whales.stablecoins]
    const usdt = whales.stablecoins[0]
    const filters = tracked.map(t => ({ address: t.address, minValue: t.minValue, indexFloor: t.indexFloor }))
    const whole = (token: { decimals: number }, n: number | string) => `(${n})::numeric * 10::numeric ^ ${token.decimals}`

    /** A hand-placed transfer: `usd` whole USDT, `ago` an interval. */
    const placed = (hashValue: string, usd: number, ago: string, block: number) =>
      `('${hashValue}', 0, '${usdt.address}', '0x${'c'.repeat(40)}', '0x${'d'.repeat(40)}', ${whole(usdt, usd)}, ${block}, now() - interval '${ago}')`

    /** table -> every whale-index relation name: the one index, or the parent and one child per partition. */
    let whaleIndexes: Set<string>

    beforeAll(async () => {
      if (!/test/i.test(new URL(PG_URL as string).pathname)) {
        throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
      }
      await conn.unsafe('DROP TABLE IF EXISTS pg_temp.token_transfers CASCADE')
      await conn.unsafe('DROP TABLE IF EXISTS pg_temp.tokens CASCADE')
      await conn.unsafe(`
        CREATE TEMP TABLE token_transfers (
          tx_hash varchar(66) NOT NULL, log_index integer NOT NULL DEFAULT 0,
          token_address varchar(42) NOT NULL, from_address varchar(42) NOT NULL, to_address varchar(42) NOT NULL,
          value numeric(78,0) NOT NULL DEFAULT 0, token_id numeric(78,0),
          block_number bigint NOT NULL, timestamp timestamptz NOT NULL
        ) ${partitioned ? 'PARTITION BY RANGE (block_number)' : ''};
        ${partitioned
          ? `CREATE TEMP TABLE token_transfers_p0 PARTITION OF token_transfers FOR VALUES FROM (0) TO (40000);
             CREATE TEMP TABLE token_transfers_p1 PARTITION OF token_transfers FOR VALUES FROM (40000) TO (80000);
             CREATE TEMP TABLE token_transfers_p2 PARTITION OF token_transfers FOR VALUES FROM (80000) TO (1000000);`
          : ''}
        CREATE TEMP TABLE tokens (address varchar(42) PRIMARY KEY, symbol text);
        INSERT INTO tokens VALUES ${tracked.map(t => `('${t.address}', '${t.symbol}')`).join(', ')};
      `)

      // Eight tokens round-robin (the three tracked ones among them). Every 53rd row is whale-size (100,001+ whole
      // tokens: above every floor, below the hand-placed $500k and $1M); the rest are 1-49 whole tokens.
      const slot = [tracked[0], null, tracked[1], null, tracked[2], null, null, null]
      const addr = slot.map((t, k) => (t ? `'${t.address}'` : `'0x${String(k).repeat(40)}'`)).join(', ')
      const decs = slot.map(t => (t ? t.decimals : 18)).join(', ')
      await conn.unsafe(`
        INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, value, block_number, timestamp)
        SELECT '0x' || md5(i::text), 0, (ARRAY[${addr}])[1 + (i % 8)], '0x${'a'.repeat(40)}', '0x${'b'.repeat(40)}',
               CASE WHEN i % 53 = 0 THEN (100001 + (i % 7919))::numeric * 10::numeric ^ (ARRAY[${decs}])[1 + (i % 8)]
                    ELSE (1 + (i % 49))::numeric * 10::numeric ^ (ARRAY[${decs}])[1 + (i % 8)] END,
               i, now() - ((${NOISE} - i) * 2.16 || ' seconds')::interval
        FROM generate_series(1, ${NOISE}) i;

        INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, value, block_number, timestamp)
        VALUES ${[
          placed(BIG_OLD, 1_000_000, '20 hours', 1000),
          placed(MID_OLD, 50_000, '10 hours', 2000),
          placed(BIG_RECENT, 500_000, '30 seconds', NOISE + 1),
          ...Array.from({ length: NEWEST_MID }, (_, i) => placed(`0x${(i + 1).toString(16).padStart(64, '0')}`, 2_000, `${i + 1} minutes`, NOISE + 2 + i)),
        ].join(',\n               ')};

        CREATE INDEX tt_token_ts_idx ON token_transfers (token_address, timestamp DESC);
        CREATE INDEX tt_whale_idx ON token_transfers (token_address, value DESC)
          WHERE ${tracked.map(t => `(token_address = '${t.address}' AND value > ${t.indexFloor})`).join(' OR ')};
        ANALYZE token_transfers;
      `)

      whaleIndexes = new Set((await rows(`
        SELECT 'tt_whale_idx' AS name
        UNION ALL SELECT c.relname FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
                  WHERE h.inhparent = 'tt_whale_idx'::regclass`)).map(r => String(r.name)))
    }, 120_000)

    afterAll(async () => {
      await conn.unsafe('DROP TABLE IF EXISTS pg_temp.token_transfers CASCADE')
      await conn.unsafe('DROP TABLE IF EXISTS pg_temp.tokens CASCADE')
    })

    const compile = (period: WhalePeriod, f = filters) => {
      const q = dialect.sqlToQuery(buildTokenWhaleQuery(period, f))
      return { text: q.sql, params: q.params as never[] }
    }

    async function candidates(period: WhalePeriod): Promise<WhaleTx[]> {
      const { text, params } = compile(period)
      return Array.from(await conn.unsafe(text, params)).map(r => ({
        hash: String(r.hash), fromAddress: String(r.fromAddress), toAddress: r.toAddress ? String(r.toAddress) : null,
        value: String(r.value), blockNumber: Number(r.blockNumber), timestamp: new Date(r.timestamp as string),
        transferType: 'token' as const, tokenSymbol: String(r.tokenSymbol), tokenAddress: String(r.tokenAddress),
      }))
    }

    /**
     * The plan, with the statement's parameters as the application sends them. `generic` plans it once with NO
     * parameter values known (plan_cache_mode = force_generic_plan), which is the strictest reading of "the literal
     * proves the predicate": production's unnamed statements are planned with their values, so they are more
     * forgiving, but a future `prepare: true` would not be.
     */
    async function plan(text: string, params: never[], generic: boolean): Promise<PlanNode[]> {
      let res
      if (!generic) {
        res = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params)
      } else {
        try {
          await conn.unsafe('SET plan_cache_mode = force_generic_plan')
          await conn.unsafe(`PREPARE whale_stmt AS ${text}`)
          res = await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE whale_stmt${params.length ? `(${params.map(p => `'${p}'`).join(', ')})` : ''}`)
        } finally {
          await conn.unsafe('DEALLOCATE ALL')
          await conn.unsafe('RESET plan_cache_mode')
        }
      }
      return flatten((res[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan)
    }

    it('has the combined index the production DDL builds: one, partial, on every tracked token', async () => {
      expect(whaleIndexes.size).toBe(1 + (partitioned ? partitions : 0))
      const [{ def }] = await rows(`SELECT pg_get_indexdef('tt_whale_idx'::regclass) AS def`)
      for (const t of tracked) {
        expect(String(def), t.symbol).toContain(`'${t.address}'`)
        expect(String(def), t.symbol).toContain(`'${t.indexFloor}'`)   // a bigint or numeric literal, depending on its size
      }
    })

    // The reason for the literals. A partial index is used only when the planner can PROVE the query implies its
    // predicate, and the proof needs the token and the floor spelled out in the statement.
    it.each(
      tracked.flatMap(t => (['24h', 'all'] as const).flatMap(p => [false, true].map(g => [t.symbol, p, g ? 'a generic plan' : 'its own parameters', g, t] as const))),
    )(
      'the whale arm of %s over %s, planned with %s, is served by tt_whale_idx on every partition, with no seq scan',
      async (_symbol, period, _mode, generic, token) => {
        const { text, params } = compile(period, [{ address: token.address, minValue: token.minValue, indexFloor: token.indexFloor }])
        const nodes = await plan(text, params, generic)
        const label = shape(nodes)
        const viaWhale = nodes.filter(n => n['Index Name'] !== undefined && whaleIndexes.has(n['Index Name']))
        expect(viaWhale.length, label).toBeGreaterThanOrEqual(partitions)
        // (The tiny `tokens` join is allowed its seq scan; token_transfers, or any partition of it, is not.)
        expect(nodes.some(n => /Seq Scan/.test(n['Node Type']) && /^token_transfers/.test(n['Relation Name'] ?? '')), label).toBe(false)
        if (partitioned) expect(nodes.some(n => n['Node Type'] === 'Merge Append'), label).toBe(true)  // value order merged across partitions
      },
    )

    // Negative control: this is what a non-literal arm would plan as. If this stopped failing, the test above
    // could no longer fail, and we would not know.
    it('the same arm with the token and floor as bound parameters, planned generically, does NOT use the index', async () => {
      try {
        await conn.unsafe('SET plan_cache_mode = force_generic_plan')
        await conn.unsafe(`PREPARE whale_arm(text, numeric) AS
          SELECT tx_hash, value FROM token_transfers
          WHERE token_address = $1 AND value > $2 AND timestamp >= NOW() - INTERVAL '24 hours'
          ORDER BY value DESC, tx_hash DESC, log_index DESC LIMIT 25`)
        const res = await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE whale_arm('${usdt.address}', ${usdt.indexFloor})`)
        const nodes = flatten((res[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan)
        expect(nodes.filter(n => n['Index Name'] !== undefined && whaleIndexes.has(n['Index Name'])), shape(nodes)).toEqual([])
      } finally {
        await conn.unsafe('DEALLOCATE ALL')
        await conn.unsafe('RESET plan_cache_mode')
      }
    })

    it('a $1M stablecoin transfer older than the newest 25 qualifying ones is now a candidate, and outranks the recent small ones', async () => {
      // Precondition, so the test cannot pass by the fixture drifting: 25+ qualifying USDT transfers are NEWER than it.
      const [{ newer }] = await rows(`
        SELECT count(*)::int AS newer FROM token_transfers
        WHERE token_address = '${usdt.address}' AND value > ${usdt.minValue}
          AND timestamp > (SELECT timestamp FROM token_transfers WHERE tx_hash = '${BIG_OLD}')`)
      expect(Number(newer)).toBeGreaterThanOrEqual(25)

      // No native price, so the wrapped token's whale-size rows (100,000+ WBNB: tens of millions of dollars at any
      // real price) sit unranked at the bottom and only the stablecoins compete for the top.
      const ranked = rankWhalesByUsd(await candidates('24h'), null, whales)

      expect(ranked[0].hash).toBe(BIG_OLD)
      expect(ranked[0].usd).toBe(1_000_000)
      expect(ranked[1].hash).toBe(BIG_RECENT)
      expect(ranked[1].usd).toBe(500_000)
      // ...ahead of the recent $2,000 ones the latest arm returns.
      const mid = ranked.findIndex(r => r.usd === 2_000)
      expect(mid).toBeGreaterThan(1)
    })

    it('returns a transfer that qualifies for both arms once', async () => {
      const out = await candidates('24h')
      expect(out.filter(r => r.hash === BIG_RECENT)).toHaveLength(1)
      // Every fixture transfer has its own hash and log_index 0, so any repeated hash is a repeated (tx_hash, log_index).
      expect(new Set(out.map(r => r.hash)).size).toBe(out.length)
    })

    it('does not claim the transfers between the display threshold and the whale floor: only the latest arm sees those', async () => {
      // The honest boundary of the new basis. $50,000 clears the stablecoin display threshold but not the $100k floor
      // the index holds, and 25 newer qualifying transfers push it out of the latest arm. The ranking note says
      // "largest whale-size" and "latest qualifying", never "largest qualifying".
      expect((await candidates('24h')).map(r => r.hash)).not.toContain(MID_OLD)
    })

    it('respects the period', async () => {
      const hashes = (await candidates('1h')).map(r => r.hash)
      expect(hashes).toContain(BIG_RECENT)
      expect(hashes).not.toContain(BIG_OLD)
      expect(hashes).not.toContain(MID_OLD)
    })

    it('returns exactly the rows a sequential scan returns, in the same order, for every window', async () => {
      for (const period of ['1h', '24h', 'all'] as const) {
        const viaIndex = (await candidates(period)).map(r => r.hash)
        try {
          await conn.unsafe('SET enable_indexscan = off')
          await conn.unsafe('SET enable_bitmapscan = off')
          await conn.unsafe('SET enable_indexonlyscan = off')
          expect((await candidates(period)).map(r => r.hash), period).toEqual(viaIndex)
        } finally {
          await conn.unsafe('RESET enable_indexscan')
          await conn.unsafe('RESET enable_bitmapscan')
          await conn.unsafe('RESET enable_indexonlyscan')
        }
      }
    })
  })
})
