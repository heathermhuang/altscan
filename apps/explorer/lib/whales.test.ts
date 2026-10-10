import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getChainConfig } from '@altscan/chain-config'
import { chainConfig } from '@/lib/chain'
import { buildTokenWhaleQuery, buildNativeWhaleQuery, settleWhaleQueries, mergeWhaleRows, rankWhalesByUsd, rankingNote, rawWeiLiteral, type WhaleTx } from '@/lib/whales'

const dialect = new PgDialect()
const toQuery = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q)

const FILTERS = [
  { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', minValue: '1000000000000000000' },
  { address: '0x55d398326f99059ff775485246999027b3197955', minValue: '1000000000000000000000' },
]

describe('buildTokenWhaleQuery', () => {
  it('never renders a row constructor, which is what broke the page', () => {
    const { sql: text } = toQuery(buildTokenWhaleQuery('24h', FILTERS))

    // The shipped bug: `= ANY(${array})` renders as `ANY(($1, $2))`, a ROW,
    // which Postgres rejects with "op ANY/ALL (array) requires array on right side".
    expect(text).not.toMatch(/ANY\s*\(\s*\(/)
  })

  it('emits one UNION ALL arm per token, each independently limited', () => {
    const { sql: text } = toQuery(buildTokenWhaleQuery('24h', FILTERS))

    // The whole latency fix rests on this shape: one early-stopping index walk
    // per token instead of a single OR-ed scan that has to sort every candidate.
    // Two tokens => one UNION ALL, and a LIMIT inside each arm plus the outer one.
    expect(text.match(/UNION ALL/g)).toHaveLength(FILTERS.length - 1)
    expect(text.match(/LIMIT 25/g)).toHaveLength(FILTERS.length + 1)
    expect(text.match(/FROM token_transfers/g)).toHaveLength(FILTERS.length)
  })

  it('binds an address and a threshold per token, in order', () => {
    const { params } = toQuery(buildTokenWhaleQuery('24h', FILTERS))
    expect(params).toEqual([
      FILTERS[0].address, FILTERS[0].minValue,
      FILTERS[1].address, FILTERS[1].minValue,
    ])
  })

  it('sorts every arm and the merge by the same deterministic key', () => {
    const { sql: text } = toQuery(buildTokenWhaleQuery('24h', FILTERS))

    // Per-arm LIMIT 25 only yields a correct global top-25 if the arms and the
    // merge agree on the ordering. Timestamp alone is not deterministic — a
    // timestamp is a block, and a hot token moves many times per block.
    const orders = text.match(/ORDER BY [^\n]+/g) ?? []
    expect(orders).toHaveLength(FILTERS.length + 2) // one per arm, merge, outer
    for (const o of orders) {
      expect(o).toMatch(/timestamp DESC, [\w.]*tx_hash DESC, [\w.]*log_index DESC/)
    }
  })

  it('refuses an empty filter list rather than emitting a dangling UNION ALL', () => {
    expect(() => buildTokenWhaleQuery('24h', [])).toThrow(/at least one token filter/)
  })

  it('selects the token contract address, which is what a row is priced by', () => {
    const { sql: text } = toQuery(buildTokenWhaleQuery('24h', FILTERS))
    expect(text).toMatch(/u\.token_address as "tokenAddress"/)
  })

  it('joins the token symbol after the limit, not before it', () => {
    const { sql: text } = toQuery(buildTokenWhaleQuery('24h', FILTERS))
    // Joining first made the lookup run against every candidate row.
    expect(text.indexOf('LEFT JOIN tokens')).toBeGreaterThan(text.lastIndexOf('LIMIT 25'))
  })
})

describe('whale thresholds stay below the measured display floor', () => {
  // Raising nativeMinWei is invisible ONLY while it stays under the smallest
  // 25th-largest transfer seen in any single hour. Measured on prod 2026-08-27
  // across every complete hour the chains retain (BNB 53h, ETH 97h), with no
  // hour holding fewer than 25 qualifying transfers.
  const FLOOR_WEI: Record<string, bigint> = {
    bnb: 41_064_787_000_000_000_000n, // 41.06 BNB
    eth: 61_563_203_000_000_000_000n, // 61.56 ETH
  }

  it.each(['bnb', 'eth'] as const)('%s', (key) => {
    const cfg = getChainConfig(key)
    const min = BigInt(cfg.whales.nativeMinWei)
    expect(min).toBeGreaterThan(0n)
    expect(min).toBeLessThan(FLOOR_WEI[key])
  })
})

describe('buildNativeWhaleQuery', () => {
  it('binds the wei threshold as a parameter', () => {
    const { sql: text, params } = toQuery(buildNativeWhaleQuery('24h', '1000000000000000000'))
    expect(text).toContain('FROM transactions')
    expect(params).toContain('1000000000000000000')
  })

  it.each([
    ['1h', "INTERVAL '1 hour'"],
    ['24h', "INTERVAL '24 hours'"],
    ['7d', "INTERVAL '7 days'"],
    ['all', "INTERVAL '30 days'"],   // 'all' is deliberately capped at 30d
  ] as const)('maps period %s to %s', (period, interval) => {
    expect(toQuery(buildNativeWhaleQuery(period, '1')).sql).toContain(interval)
  })
})

describe('settleWhaleQueries', () => {
  it('keeps the native rows when the token query fails', async () => {
    const nativeRow = { hash: '0xabc', fromAddress: '0xf', toAddress: '0xt',
      value: '1', blockNumber: 1, timestamp: new Date().toISOString(), transferType: 'native' }

    const result = await settleWhaleQueries(
      Promise.resolve([nativeRow]),
      Promise.reject(new Error('boom')),
    )

    expect(result.native).toHaveLength(1)
    expect(result.token).toBeNull()      // null = failed, distinct from []
  })

  it('keeps the token rows when the native query fails', async () => {
    const tokenRow = { hash: '0xdef', fromAddress: '0xf', toAddress: '0xt',
      value: '1', blockNumber: 1, timestamp: new Date().toISOString(), transferType: 'token' }

    const result = await settleWhaleQueries(
      Promise.reject(new Error('boom')),
      Promise.resolve([tokenRow]),
    )

    expect(result.native).toBeNull()
    expect(result.token).toHaveLength(1)
  })

  it('distinguishes an empty success from a failure', async () => {
    const result = await settleWhaleQueries(Promise.resolve([]), Promise.resolve([]))
    expect(result.native).toEqual([])
    expect(result.token).toEqual([])
  })
})

describe('mergeWhaleRows', () => {
  const row = (hash: string, value: string, extra: Partial<WhaleTx> = {}): WhaleTx => ({
    hash, fromAddress: '0xf', toAddress: '0xt', value, blockNumber: 1,
    timestamp: new Date(), transferType: 'native', ...extra,
  })

  it('treats a null half as absent, not as an error', () => {
    expect(mergeWhaleRows(null, [row('0xa', '1')]).map(r => r.hash)).toEqual(['0xa'])
    expect(mergeWhaleRows([row('0xb', '1')], null).map(r => r.hash)).toEqual(['0xb'])
    expect(mergeWhaleRows(null, null)).toEqual([])
  })

  it('never orders by raw amount across units', () => {
    // The shipped bug: 32,800 USDT (~$33k) outranked 15,000 BNB (~$11M) because 32,800e18 > 15,000e18.
    // Ranking needs a price, so the merge only unions; it must not put the larger raw number first.
    const bnb = row('0xbnb', '15000000000000000000000')
    const usdt = row('0xusdt', '32800000000000000000000', { transferType: 'token' })

    expect(mergeWhaleRows([bnb], [usdt]).map(r => r.hash)).toEqual(['0xbnb', '0xusdt'])
  })

  it('unions both halves whole: the queries already cap at 25 + 25, so a second cap here would cut rows by raw value', () => {
    const native = Array.from({ length: 25 }, (_, i) => row(`0xn${i}`, String(i)))
    const token = Array.from({ length: 25 }, (_, i) => row(`0xt${i}`, String(i), { transferType: 'token' }))

    expect(mergeWhaleRows(native, token)).toHaveLength(50)
    // Past the SQL caps nothing is dropped here either; ranking, not the merge, decides order.
    const more = Array.from({ length: 60 }, (_, i) => row(`0x${i}`, String(i)))
    expect(mergeWhaleRows(more, null)).toHaveLength(60)
  })
})

describe('rankWhalesByUsd', () => {
  const NOW = new Date('2026-10-10T12:00:00Z')
  const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000)
  const E18 = 10n ** 18n

  // BNB-shaped: 18-decimal stablecoins.
  const BNB_CFG = {
    wrapped: { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, minValue: '1' },
    stablecoins: [
      { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, minValue: '1' },
      { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18, minValue: '1' },
    ],
  }
  // ETH-shaped: 6-decimal stablecoins, so a raw amount is a different size per unit.
  const ETH_CFG = {
    wrapped: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18, minValue: '1' },
    stablecoins: [
      { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, minValue: '1' },
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, minValue: '1' },
    ],
  }

  const native = (hash: string, whole: bigint, secondsAgo = 60): WhaleTx => ({
    hash, fromAddress: '0xf', toAddress: '0xt', value: String(whole * E18), blockNumber: 1,
    timestamp: at(secondsAgo), transferType: 'native', tokenSymbol: 'BNB',
  })
  const token = (hash: string, tokenAddress: string, rawValue: string, secondsAgo = 60, tokenSymbol = 'TOKEN'): WhaleTx => ({
    hash, fromAddress: '0xf', toAddress: '0xt', value: rawValue, blockNumber: 1,
    timestamp: at(secondsAgo), transferType: 'token', tokenSymbol, tokenAddress,
  })

  it('ranks 15,000 BNB (~$11M) above 32,800 USDT (~$33k), the shipped bug', () => {
    const usdt = token('0xusdt', BNB_CFG.stablecoins[0].address, String(32_800n * E18), 60, 'USDT')
    const bnb = native('0xbnb', 15_000n)

    const ranked = rankWhalesByUsd([usdt, bnb], 730, BNB_CFG)

    expect(ranked.map(r => r.hash)).toEqual(['0xbnb', '0xusdt'])
    expect(ranked[0].usd).toBeCloseTo(10_950_000, 0)
    expect(ranked[1].usd).toBeCloseTo(32_800, 0)
  })

  it('never compares raw amounts across units: 1M USDT (6dp) outranks 100 ETH even though its raw number is smaller', () => {
    const eth = native('0xeth', 100n)                                              // 1e20 raw
    const usdt = token('0xusdt', ETH_CFG.stablecoins[0].address, '1000000000000')  // 1e12 raw = 1,000,000 USDT

    const ranked = rankWhalesByUsd([eth, usdt], 2000, ETH_CFG)

    expect(ranked.map(r => r.hash)).toEqual(['0xusdt', '0xeth'])
    expect(ranked[0].usd).toBe(1_000_000)
    expect(ranked[1].usd).toBe(200_000)
  })

  it('reads each token decimals from its contract address, not its symbol', () => {
    const usdt = token('0xusdt', ETH_CFG.stablecoins[0].address, '32800000000')
    const [r] = rankWhalesByUsd([usdt], 2000, ETH_CFG)

    expect(r.decimals).toBe(6)
    expect(r.usd).toBe(32_800)
  })

  it('prices the wrapped native token at the native price', () => {
    const wbnb = token('0xw', BNB_CFG.wrapped.address, String(10n * E18), 60, 'WBNB')
    const [r] = rankWhalesByUsd([wbnb], 700, BNB_CFG)

    expect(r.usd).toBe(7_000)
    expect(r.decimals).toBe(18)
  })

  it('pegs a stablecoin only by contract address: a token that merely says USDT has no price', () => {
    // Symbols are spoofable. A scam token calling itself USDT must not get $1, however large its raw amount.
    const fake = token('0xfake', '0x0000000000000000000000000000000000000bad', String(9_000_000n * E18), 60, 'USDT')
    const real = token('0xreal', BNB_CFG.stablecoins[0].address, String(40_000n * E18), 120, 'USDT')

    const ranked = rankWhalesByUsd([fake, real], 730, BNB_CFG)

    expect(ranked.map(r => r.hash)).toEqual(['0xreal', '0xfake'])
    expect(ranked[1].usd).toBeNull()
  })

  it('matches addresses case-insensitively', () => {
    const upper = token('0xu', BNB_CFG.stablecoins[0].address.toUpperCase().replace('0X', '0x'), String(5n * E18))
    expect(rankWhalesByUsd([upper], 730, BNB_CFG)[0].usd).toBe(5)
  })

  it('puts rows with no price after every priced row, newest first, whatever their raw size', () => {
    const unknownBig = token('0xbig', '0x00000000000000000000000000000000000000aa', String(10n ** 30n), 10)
    const unknownOld = token('0xold', '0x00000000000000000000000000000000000000bb', '1', 500)
    const usdt = token('0xusdt', BNB_CFG.stablecoins[0].address, String(1_000n * E18), 300)

    const ranked = rankWhalesByUsd([unknownOld, unknownBig, usdt], 730, BNB_CFG)

    expect(ranked.map(r => r.hash)).toEqual(['0xusdt', '0xbig', '0xold'])
    expect(ranked.map(r => r.usd)).toEqual([1_000, null, null])
  })

  it('has no price for native and wrapped when the native price is unknown, and still ranks the stablecoins', () => {
    const bnb = native('0xbnb', 15_000n, 10)
    const wbnb = token('0xw', BNB_CFG.wrapped.address, String(10n * E18), 20, 'WBNB')
    const usdt = token('0xusdt', BNB_CFG.stablecoins[0].address, String(32_800n * E18), 300, 'USDT')

    const ranked = rankWhalesByUsd([bnb, wbnb, usdt], null, BNB_CFG)

    expect(ranked.map(r => r.hash)).toEqual(['0xusdt', '0xbnb', '0xw'])
    expect(ranked.map(r => r.usd)).toEqual([32_800, null, null])
  })

  it('treats a zero or non-finite native price as unknown, not as a price of nothing', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(rankWhalesByUsd([native('0xbnb', 5n)], bad, BNB_CFG)[0].usd).toBeNull()
    }
  })

  it('breaks a tie on the same value by recency, then hash, so ISR renders never reshuffle', () => {
    const a = token('0xa', BNB_CFG.stablecoins[0].address, String(1_000n * E18), 100)
    const b = token('0xb', BNB_CFG.stablecoins[1].address, String(1_000n * E18), 50)
    const c = token('0xc', BNB_CFG.stablecoins[0].address, String(1_000n * E18), 50)

    const once = rankWhalesByUsd([a, b, c], 730, BNB_CFG).map(r => r.hash)
    const reversed = rankWhalesByUsd([c, b, a], 730, BNB_CFG).map(r => r.hash)

    expect(once).toEqual(['0xc', '0xb', '0xa']) // newest first; the 50s tie breaks on hash, descending
    expect(reversed).toEqual(once)
  })

  it('ranks a numeric(78,18) value with its decimal tail instead of throwing', () => {
    const scaled = { ...native('0xs', 1n), value: '10000000000000000000.000000000000000000' } // 10 BNB with the tail postgres-js returns
    const plain = native('0xp', 9n)

    expect(rankWhalesByUsd([plain, scaled], 700, BNB_CFG).map(r => r.hash)).toEqual(['0xs', '0xp'])
  })

  it('returns plain JSON: no BigInt can reach the page cache', () => {
    const ranked = rankWhalesByUsd([native('0xbnb', 5n), token('0xt', BNB_CFG.stablecoins[0].address, '5')], 700, BNB_CFG)

    expect(() => JSON.stringify(ranked)).not.toThrow()
    for (const r of ranked) {
      expect(typeof r.value).toBe('string')
      expect(typeof r.decimals).toBe('number')
      expect(r.usd === null || typeof r.usd === 'number').toBe(true)
    }
  })
})

describe('buildNativeWhaleQuery carries the partial-index floor as a literal', () => {
  it('emits the floor inline, not as a bound parameter', () => {
    const { sql: text, params } = toQuery(
      buildNativeWhaleQuery('24h', chainConfig.whales.nativeMinWei),
    )
    const floor = chainConfig.whales.nativeIndexFloorWei

    // A parameter here defeats the partial index under a generic plan: Postgres
    // cannot prove `$1 >= floor`, discards tx_whale_value_idx and seq-scans.
    // Measured on PG16 with force_generic_plan: 52,744 buffers vs 27.
    expect(text).toContain(`value > ${floor}`)
    expect(params).not.toContain(floor)
  })

  it('still binds the configured threshold as a parameter', () => {
    const { params } = toQuery(
      buildNativeWhaleQuery('24h', chainConfig.whales.nativeMinWei),
    )
    expect(params).toContain(chainConfig.whales.nativeMinWei)
  })

  it.each([
    ["1'; DROP TABLE transactions --"],
    ['1e18'],
    [''],
    ['1000000000000000000 '],
  ])('refuses %j as a floor, because it is spliced in unescaped', (bad) => {
    expect(() => rawWeiLiteral(bad)).toThrow(/must be digits/)
  })

  it('accepts the configured floor', () => {
    expect(() => rawWeiLiteral(chainConfig.whales.nativeIndexFloorWei)).not.toThrow()
  })
})

describe('rankingNote', () => {
  it('states the live-price basis only when a native price is known', () => {
    const note = rankingNote('BNB', 'WBNB', true)
    expect(note).toContain('at the live BNB price')
    expect(note).toContain('stablecoins at $1')
  })

  it('says plainly that the native price is unavailable, and that native rows are unranked, when it is not', () => {
    const note = rankingNote('ETH', 'WETH', false)
    expect(note).not.toMatch(/live/i)
    expect(note).toContain('ETH price is unavailable')
    expect(note).toMatch(/ETH and WETH transfers .*unranked/)
  })
})
