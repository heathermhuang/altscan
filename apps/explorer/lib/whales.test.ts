import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { buildTokenWhaleQuery, buildNativeWhaleQuery, settleWhaleQueries, mergeWhaleRows, type WhaleTx } from '@/lib/whales'

const dialect = new PgDialect()
const toQuery = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q)

const FILTERS = [
  { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', minValue: '1000000000000000000' },
  { address: '0x55d398326f99059ff775485246999027b3197955', minValue: '1000000000000000000000' },
]

describe('buildTokenWhaleQuery', () => {
  it('expands the token list as an IN list, never a row constructor', () => {
    const { sql: text } = toQuery(buildTokenWhaleQuery('24h', FILTERS))

    // The shipped bug: `= ANY(${array})` renders as `ANY(($1, $2))`, a ROW,
    // which Postgres rejects with "op ANY/ALL (array) requires array on right side".
    expect(text).not.toMatch(/ANY\s*\(\s*\(/)
    expect(text).toContain('IN ($1, $2)')
  })

  it('binds one parameter per token address', () => {
    const { params } = toQuery(buildTokenWhaleQuery('24h', FILTERS))
    expect(params).toContain(FILTERS[0].address)
    expect(params).toContain(FILTERS[1].address)
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
