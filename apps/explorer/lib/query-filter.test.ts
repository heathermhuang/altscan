import { describe, expect, it } from 'vitest'
import { parseQuery } from './query-filter'

const A = '0x' + 'aB'.repeat(20)
const B = '0x' + 'cd'.repeat(20)
const refused = (body: unknown) => {
  const r = parseQuery(body)
  if (r.ok) throw new Error(`accepted ${JSON.stringify(body)}`)
  return r.error
}
const accepted = (body: unknown) => {
  const r = parseQuery(body)
  if (!r.ok) throw new Error(`refused ${JSON.stringify(body)}: ${r.error}`)
  return r.query
}

describe('parseQuery — the body', () => {
  it.each([null, [], 'transactions', 42])('refuses a body that is not an object: %j', (body) => {
    expect(refused(body)).toMatch(/JSON object/)
  })

  it('refuses a missing or unknown entity', () => {
    expect(refused({})).toMatch(/Invalid entity/)
    expect(refused({ entity: 'accounts' })).toMatch(/Invalid entity/)
  })

  it.each([null, [], 'x'])('refuses a filter that is not an object: %j', (filter) => {
    expect(refused({ entity: 'blocks', filter })).toMatch(/filter must be an object/)
  })

  it('refuses an orderBy other than asc or desc', () => {
    expect(refused({ entity: 'blocks', orderBy: 'random' })).toMatch(/orderBy/)
  })

  it('keeps the lenient limit and the offset cap', () => {
    expect(accepted({ entity: 'blocks', limit: 500 })).toMatchObject({ limit: 100, offset: 0, orderBy: 'desc' })
    expect(accepted({ entity: 'blocks', limit: 0 }).limit).toBe(25)
    expect(refused({ entity: 'blocks', offset: 10_001 })).toMatch(/offset/)
  })
})

describe('parseQuery — block filters are integers before they reach Postgres', () => {
  // A string reached Postgres as a bigint parameter, and its 22P02 error quoted it into the log.
  it.each(['x\n[audit-marker] forged\n', '12', 1.5, -1, null, true, Number.MAX_SAFE_INTEGER + 2])('refuses %j', (v) => {
    expect(refused({ entity: 'blocks', filter: { blockFrom: v } })).toMatch(/filter\.blockFrom must be a non-negative integer/)
  })

  it('refuses a range whose start is after its end', () => {
    expect(refused({ entity: 'blocks', filter: { blockFrom: 10, blockTo: 9 } })).toMatch(/blockFrom must not be greater/)
  })

  it('accepts 0, which a truthiness check used to drop', () => {
    expect(accepted({ entity: 'blocks', filter: { blockFrom: 0, blockTo: 0 } }).filter).toEqual({ blockFrom: 0, blockTo: 0 })
  })
})

describe('parseQuery — only filter shapes an index serves', () => {
  it.each([
    ['transactions', { address: A }],
    ['transactions', { from: A, blockFrom: 1, blockTo: 9 }],
    ['transactions', { to: A, blockNumber: 5 }],
    ['transactions', { blockNumber: 5 }],
    ['token_transfers', { tokenAddress: A, blockFrom: 42_000_000 }],   // the /developer page's example
    ['token_transfers', { address: A, blockTo: 9 }],
    ['token_transfers', {}],
    ['blocks', { blockFrom: 1, blockTo: 9 }],
    ['dex_trades', { blockFrom: 1 }],
    ['tokens', {}],
  ])('accepts %s %j', (entity, filter) => {
    expect(accepted({ entity, filter }).entity).toBe(entity)
  })

  it.each([
    ['transactions', { address: A, from: B }, /one of filter\.address, filter\.from, filter\.to at a time/],
    ['transactions', { from: A, to: B }, /not filter\.from and filter\.to/],
    ['token_transfers', { from: A, tokenAddress: B }, /one of filter\.address, filter\.from, filter\.to, filter\.tokenAddress/],
    ['token_transfers', { address: A, tokenAddress: B }, /at a time/],
  ])('refuses two key filters at once: %s %j', (entity, filter, message) => {
    expect(refused({ entity, filter })).toMatch(message)
  })

  it.each([
    ['dex_trades', { address: A }, /dex_trades takes only filter\.blockFrom, filter\.blockTo; not filter\.address/],
    ['dex_trades', { dex: 'PancakeSwap V2' }, /not filter\.dex/],
    ['blocks', { blockNumber: 5 }, /not filter\.blockNumber/],
    ['token_transfers', { blockNumber: 5 }, /not filter\.blockNumber/],
    ['tokens', { address: A }, /tokens takes no filters; not filter\.address/],
    ['transactions', { tokenAddress: A }, /not filter\.tokenAddress/],
  ])('refuses a field the entity does not take, instead of ignoring it: %s %j', (entity, filter, message) => {
    expect(refused({ entity, filter })).toMatch(message)
  })

  it('validates and lowercases addresses', () => {
    expect(accepted({ entity: 'transactions', filter: { from: A } }).filter.from).toBe(A.toLowerCase())
    expect(refused({ entity: 'transactions', filter: { from: '0x1234' } })).toMatch(/Invalid filter\.from/)
    expect(refused({ entity: 'transactions', filter: { address: null } })).toMatch(/Invalid filter\.address/)
  })
})
