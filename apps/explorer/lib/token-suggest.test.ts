import { describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema, type Db } from '@altscan/db'
import { likePrefixPattern, shapeSuggestions, suggestPrefix, suggestQuery, SUGGEST_LIMIT } from '@/lib/token-suggest'

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const row = (i: number, symbol: string, name: string, holderCount: number) => ({ address: addr(i), symbol, name, holderCount })

describe('suggestPrefix', () => {
  it('lowercases and trims', () => {
    expect(suggestPrefix('  UsDt ')).toBe('usdt')
  })

  it('needs 2 to 50 characters, the symbol column being varchar(50)', () => {
    expect(suggestPrefix('u')).toBeNull()
    expect(suggestPrefix(' u ')).toBeNull()
    expect(suggestPrefix('us')).toBe('us')
    expect(suggestPrefix('a'.repeat(50))).toBe('a'.repeat(50))
    expect(suggestPrefix('a'.repeat(51))).toBeNull()
    expect(suggestPrefix(null)).toBeNull()
  })

  it('refuses a NUL byte, which Postgres rejects in text', () => {
    expect(suggestPrefix('us\u0000dt')).toBeNull()
  })
})

describe('likePrefixPattern', () => {
  it('escapes % _ and \\ so the visitor\'s text is matched literally, then appends the wildcard', () => {
    expect(likePrefixPattern('usdt')).toBe('usdt%')
    expect(likePrefixPattern('100%')).toBe('100\\%%')
    expect(likePrefixPattern('a_b')).toBe('a\\_b%')
    expect(likePrefixPattern('a\\b')).toBe('a\\\\b%')
  })
})

describe('suggestQuery', () => {
  // drizzle.mock builds queries with no connection, so the SQL the driver would send can be read off.
  const db = drizzle.mock({ schema }) as unknown as Db

  it('is lower(symbol) LIKE prefix%, most-held first (plain DESC), 20 candidates, four columns', () => {
    expect(suggestQuery(db, 'us_').toSQL()).toEqual({
      sql: 'select "address", "symbol", "name", "holder_count" from "tokens" where lower("tokens"."symbol") like $1 order by "tokens"."holder_count" desc limit $2',
      params: ['us\\_%', 20],
    })
  })
})

describe('shapeSuggestions', () => {
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

  it('returns at most five rows, as plain JSON-safe objects with holders as a number', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, `AB${i}`, `Ab ${i}`, 100 - i))
    const out = shapeSuggestions(rows, 'ab', 'bnb')
    expect(out).toHaveLength(SUGGEST_LIMIT)
    expect(out[0]).toEqual({ address: addr(1), symbol: 'AB0', name: 'Ab 0', holders: 100, lookalike: false })
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('lists every real token before any lookalike, flagging the lookalikes', () => {
    const rows = [
      row(1, 'WBNB', 'Wrapped BNB', 9_000_000),  // not the WBNB contract: a lookalike
      row(2, 'WBNB', 'Wrapped BNB', 8_000_000),  // lookalike
      { address: WBNB, symbol: 'WBNB', name: 'Wrapped BNB', holderCount: 500_000 },
      row(3, 'WBNX', 'Wbnx Coin', 10),
    ]
    const out = shapeSuggestions(rows, 'wb', 'bnb')
    expect(out.map((r) => [r.address === WBNB ? 'real' : r.address.slice(-2), r.lookalike])).toEqual([
      ['real', false], ['03', false], ['01', true], ['02', true],
    ])
  })

  it('puts an exact symbol before a longer one that merely starts with it', () => {
    const rows = [row(1, 'CAKEX', 'Cakex', 900), row(2, 'CAKE', 'PancakeSwap Token', 100)]
    expect(shapeSuggestions(rows, 'cake', 'bnb').map((r) => r.symbol)).toEqual(['CAKE', 'CAKEX'])
  })
})
