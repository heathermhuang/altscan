import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { buildTokenWhaleQuery, buildNativeWhaleQuery, settleWhaleQueries } from '@/lib/whales'
import { safeBigInt } from '@/lib/format'

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

  it('sorts values that carry a numeric(78,18) decimal tail', async () => {
    // The exact shape postgres-js returns for transactions.value.
    const withScale = { hash: '0xa', fromAddress: '0xf', toAddress: '0xt',
      value: '5000000000000000000.000000000000000000', blockNumber: 1,
      timestamp: new Date().toISOString(), transferType: 'native' }
    const plain = { ...withScale, hash: '0xb', value: '9000000000000000000' }

    const result = await settleWhaleQueries(
      Promise.resolve([withScale, plain]),
      Promise.resolve([]),
    )
    expect(result.native).toHaveLength(2)

    const sorted = [...result.native!].sort((a, b) => {
      const av = safeBigInt(a.value), bv = safeBigInt(b.value)
      return bv > av ? 1 : bv < av ? -1 : 0
    })
    expect(sorted[0].hash).toBe('0xb')   // 9e18 outranks 5e18
  })
})
