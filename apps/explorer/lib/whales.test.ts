import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getChainConfig } from '@altscan/chain-config'
import { buildTokenWhaleQuery, buildNativeWhaleQuery, settleWhaleQueries, mergeWhaleRows, type WhaleTx } from '@/lib/whales'

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
  const row = (hash: string, value: string): WhaleTx => ({
    hash, fromAddress: '0xf', toAddress: '0xt', value, blockNumber: 1,
    timestamp: new Date(), transferType: 'native',
  })

  it('ranks values that carry a numeric(78,18) decimal tail', () => {
    // The exact shape postgres-js returns for transactions.value. Raw BigInt()
    // throws SyntaxError on this, so a broken comparator fails here rather than
    // silently misordering. Digit counts deliberately differ (20 vs 19) so
    // lexicographic and numeric ordering disagree.
    const scaled = row('0xa', '10000000000000000000.000000000000000000')  // 1e19, 20 digits
    const plain = row('0xb', '9000000000000000000')                       // 9e18, 19 digits

    const merged = mergeWhaleRows([scaled, plain], [])

    expect(merged.map(r => r.hash)).toEqual(['0xa', '0xb'])   // 1e19 outranks 9e18
  })

  it('treats a null half as absent, not as an error', () => {
    expect(mergeWhaleRows(null, [row('0xa', '1')]).map(r => r.hash)).toEqual(['0xa'])
    expect(mergeWhaleRows([row('0xb', '1')], null).map(r => r.hash)).toEqual(['0xb'])
    expect(mergeWhaleRows(null, null)).toEqual([])
  })

  it('ranks numerically before capping at 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`0x${i}`, String(i)))

    const merged = mergeWhaleRows(many, [])

    expect(merged).toHaveLength(50)
    // Ranked before sliced: the top value must survive.
    expect(merged[0].value).toBe('59')
    // Numeric, not lexicographic: a lexicographic sort would rank '9' first.
    expect(merged.map(r => r.value)).not.toContain('9')
  })
})
