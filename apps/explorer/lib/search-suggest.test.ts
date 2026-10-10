import { describe, expect, it } from 'vitest'
import { hintFor, indexOfKey, nextActive, suggestTokensFor, tokenQuery, type TokenSuggestion } from '@/lib/search-suggest'

const TX = 'aB'.repeat(32)
const ADDR = 'Cd'.repeat(20)
const tok = (symbol: string, holders = 1): TokenSuggestion => ({ address: `0x${symbol}`, symbol, name: symbol, holders, lookalikeOf: null })

describe('hintFor: the detected format, from the text alone (no request)', () => {
  it('names a block, with the number grouped and the href the form would go to', () => {
    expect(hintFor('#126779120')).toEqual({ kind: 'block', label: 'Block', value: '#126,779,120', href: '/blocks/126779120' })
    expect(hintFor('126,779,120')).toEqual({ kind: 'block', label: 'Block', value: '#126,779,120', href: '/blocks/126779120' })
    expect(hintFor('7')).toEqual({ kind: 'block', label: 'Block', value: '#7', href: '/blocks/7' })
  })

  it('groups digits in threes from the right, whatever the length', () => {
    expect(['7', '123', '1234', '12345', '123456', '1234567'].map((q) => hintFor(q)?.value))
      .toEqual(['#7', '#123', '#1,234', '#12,345', '#123,456', '#1,234,567'])
  })

  it('names a transaction and an address, shortening the hex and adding the missing 0x', () => {
    expect(hintFor(TX)).toEqual({ kind: 'tx', label: 'Transaction', value: '0xaBaBaB…aBaBaBaB', href: `/tx/0x${TX}` })
    expect(hintFor(`0X${ADDR}`)).toEqual({ kind: 'address', label: 'Address', value: '0xCdCdCd…CdCdCdCd', href: `/address/0x${ADDR}` })
  })

  it('has no hint for token text, a half-typed hash, or nothing', () => {
    expect(hintFor('usdt')).toBeNull()
    expect(hintFor('0x1234')).toBeNull()
    expect(hintFor('')).toBeNull()
    expect(hintFor('  ')).toBeNull()
  })
})

describe('tokenQuery: what to look tokens up with', () => {
  it('is the normalised text when it is token-like and at least 2 characters', () => {
    expect(tokenQuery('  USDT ')).toBe('usdt')
    expect(tokenQuery('#cake')).toBe('cake')
    expect(tokenQuery('us')).toBe('us')
  })

  it('is null for 1 character, for a block, a tx hash, an address, or more than a symbol can hold', () => {
    expect(tokenQuery('u')).toBeNull()
    expect(tokenQuery('125,761,128')).toBeNull()
    expect(tokenQuery(TX)).toBeNull()
    expect(tokenQuery(ADDR)).toBeNull()
    expect(tokenQuery('a'.repeat(51))).toBeNull()
  })
})

describe('suggestTokensFor: earlier answers narrowed to what is typed now', () => {
  it('keeps only the tokens whose symbol starts with the current text', () => {
    const earlier = [tok('USDT'), tok('USDC'), tok('USX')]
    expect(suggestTokensFor('usd', earlier).map((t) => t.symbol)).toEqual(['USDT', 'USDC'])
    expect(suggestTokensFor('us', earlier)).toHaveLength(3)
  })

  it('shows nothing when there is no token text', () => {
    expect(suggestTokensFor(null, [tok('USDT')])).toEqual([])
  })
})

describe('nextActive: arrow keys through the options', () => {
  it('ArrowDown goes forward from "none" and wraps; ArrowUp goes back from "none" to the last and wraps', () => {
    expect(nextActive(-1, 3, 'ArrowDown')).toBe(0)
    expect(nextActive(0, 3, 'ArrowDown')).toBe(1)
    expect(nextActive(2, 3, 'ArrowDown')).toBe(0)
    expect(nextActive(-1, 3, 'ArrowUp')).toBe(2)
    expect(nextActive(0, 3, 'ArrowUp')).toBe(2)
    expect(nextActive(2, 3, 'ArrowUp')).toBe(1)
  })

  it('is "none" when there are no options', () => {
    expect(nextActive(-1, 0, 'ArrowDown')).toBe(-1)
    expect(nextActive(0, 0, 'ArrowUp')).toBe(-1)
  })
})

describe('indexOfKey: the highlight follows the option, not its position', () => {
  it('finds the option by its key wherever it now is', () => {
    expect(indexOfKey(['hint', 'a', 'b'], 'b')).toBe(2)
    // an answer arrived and put two tokens ahead of it: still the same option
    expect(indexOfKey(['hint', 'c', 'd', 'b'], 'b')).toBe(3)
  })

  it('is -1 once the option is gone, so Enter submits the form instead of picking a different token', () => {
    expect(indexOfKey(['hint', 'c', 'd'], 'b')).toBe(-1)
    expect(indexOfKey(['hint', 'a'], null)).toBe(-1)
    expect(indexOfKey([], 'b')).toBe(-1)
  })
})

describe('adversarial input in the box', () => {
  const ms = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t }

  it('groups a 16,000-digit block number (capped at 200 digits) in under 5 ms', () => {
    const q = '1'.repeat(16_000)
    hintFor(q) // warm up
    expect(ms(() => hintFor(q))).toBeLessThan(5)
    expect(hintFor(q)?.value).toBe('#' + '1'.repeat(200).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
    expect(ms(() => hintFor(q + 'x'))).toBeLessThan(5)
    expect(ms(() => tokenQuery(q + 'x'))).toBeLessThan(5)
  })
})
