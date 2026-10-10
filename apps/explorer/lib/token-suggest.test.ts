import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Db } from '@altscan/db'
import { likePrefixPattern, shapeSuggestions, suggestPrefix, suggestQuery, suggestRows, SUGGEST_LIMIT } from '@/lib/token-suggest'

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
  const rendered = new PgDialect().sqlToQuery(suggestQuery('us_'))
  const flat = rendered.sql.replace(/\s+/g, ' ')

  it('looks the escaped prefix up in both arms, as lower(symbol) LIKE', () => {
    expect(rendered.params).toEqual(['us\\_%', 'us\\_%'])
    expect(flat.match(/lower\(symbol\) LIKE \$\d/g)).toHaveLength(2)
  })

  // Neither arm may depend on the planner's guess of how many rows match (see the module comment).
  it('bounds both arms: the 5000 most-held tokens, and 300 matches read in index order', () => {
    expect(flat).toContain('ORDER BY holder_count DESC LIMIT 5000) popular')
    expect(flat).toContain('ORDER BY lower(symbol) USING ~<~ LIMIT 300)')
  })

  it('ranks the union by holders, plain DESC, over 50 candidates (as /search)', () => {
    expect(flat).toMatch(/\) matches ORDER BY holder_count DESC LIMIT 50$/)
    expect(flat).not.toMatch(/nulls last/i)
  })
})

describe('suggestRows', () => {
  it('runs the query and maps the snake_case columns', async () => {
    const execute = async () => [{ address: '0xa', symbol: 'CAKE', name: 'PancakeSwap Token', holder_count: 7 }]
    expect(await suggestRows({ execute } as unknown as Db, 'cak')).toEqual([
      { address: '0xa', symbol: 'CAKE', name: 'PancakeSwap Token', holderCount: 7 },
    ])
  })
})

describe('shapeSuggestions', () => {
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

  it('returns at most five rows, as plain JSON-safe objects with holders as a number', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, `AB${i}`, `Ab ${i}`, 100 - i))
    const out = shapeSuggestions(rows, 'ab', 'bnb')
    expect(out).toHaveLength(SUGGEST_LIMIT)
    expect(out[0]).toEqual({ address: addr(1), symbol: 'AB0', name: 'Ab 0', holders: 100, lookalikeOf: null })
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
    expect(out.map((r) => [r.address === WBNB ? 'real' : r.address.slice(-2), r.lookalikeOf])).toEqual([
      ['real', null], ['03', null], ['01', 'WBNB'], ['02', 'WBNB'],
    ])
  })

  it('puts an exact symbol before a longer one that merely starts with it', () => {
    const rows = [row(1, 'CAKEX', 'Cakex', 900), row(2, 'CAKE', 'PancakeSwap Token', 100)]
    expect(shapeSuggestions(rows, 'cake', 'bnb').map((r) => r.symbol)).toEqual(['CAKE', 'CAKEX'])
  })

  it('judges lookalikes by the chain it is asked about', () => {
    const ethUsdt = { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', holderCount: 5 }
    expect(shapeSuggestions([ethUsdt], 'usdt', 'eth')[0].lookalikeOf).toBeNull()
    expect(shapeSuggestions([ethUsdt], 'usdt', 'bnb')[0].lookalikeOf).toBe('USDT')
  })

  // The suggestion names what it imitates, so the badge can say "lookalike of USDT" to a screen reader, as /search's does.
  it('names the token a lookalike imitates, whether its symbol or its name does the imitating', () => {
    const bySymbol = row(1, 'USDT', 'Some Coin', 10)
    const byName = row(2, 'USX', 'Tether USD', 9)
    const out = shapeSuggestions([bySymbol, byName], 'us', 'bnb')
    expect(out.map((r) => r.lookalikeOf)).toEqual(['USDT', 'USDT'])
  })
})
