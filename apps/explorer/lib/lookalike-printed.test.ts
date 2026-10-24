import { describe, it, expect } from 'vitest'
import { sanitizeSymbol } from '@altscan/explorer-core/format'
import { foldConfusables, lookalikeOf, withLookalikes } from './lookalike'

// The pages print sanitizeSymbol(symbol), which strips every non-ASCII character the glyph table has no entry for. The fold
// keeps them, so "US<euro>DT" folded to something that is not USDT while the page displayed USDT: the lookalike check failed
// open on exactly the text a reader sees. lookalikeOf now judges the text as typed AND as printed.
const BNB_USDT = '0x55d398326f99059fF775485246999027B3197955'
const SPAM = '0x00000000000000000000000000000000deadbeef'
const EURO = '€'
const usdtBnb = { symbol: 'USDT', canonical: BNB_USDT }

describe('lookalikeOf: the text as the pages print it', () => {
  it('premise: the fold keeps a character the sanitiser strips', () => {
    expect(foldConfusables(`US${EURO}DT`)).not.toBe('USDT')
    expect(sanitizeSymbol(`US${EURO}DT`)).toBe('USDT')
  })

  it('flags a symbol that only reads as a well-known one once sanitised', () => {
    for (const symbol of [`US${EURO}DT`, `USDT${EURO}`, 'USDT✅', 'US✓DT', 'U\u{1F680}SDT']) {
      expect(lookalikeOf({ address: SPAM, symbol, name: 'x' }, 'bnb'), symbol).toEqual(usdtBnb)
    }
  })

  it('flags by name alone the same way', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'x', name: `Tether US${EURO}D` }, 'bnb')).toEqual(usdtBnb)
    expect(lookalikeOf({ address: SPAM, name: `US${EURO}DT` }, 'bnb')).toEqual(usdtBnb)
  })

  it('judges the ethereum table the same way', () => {
    expect(lookalikeOf({ address: SPAM, symbol: `US${EURO}DC` }, 'eth')).toEqual({ symbol: 'USDC', canonical: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' })
  })

  it('still clears the real contract, however its symbol is typed', () => {
    expect(lookalikeOf({ address: BNB_USDT, symbol: `US${EURO}DT`, name: 'Tether USD' }, 'bnb')).toBeNull()
  })

  it('does not flag text that sanitises to nothing or to something unrelated', () => {
    expect(lookalikeOf({ address: SPAM, symbol: '泰达币', name: '✅✅' }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: `CAKE${EURO}`, name: 'PancakeSwap Token' }, 'bnb')).toBeNull()
  })
})

describe('withLookalikes', () => {
  const rows = [
    { tokenAddress: SPAM, tokenSymbol: 'USDT' },
    { tokenAddress: BNB_USDT, tokenSymbol: 'USDT' },
    { tokenAddress: SPAM, tokenSymbol: 'CAKE' },
  ]

  it('attaches the verdict to each row and leaves the rest of the row alone', () => {
    const out = withLookalikes(rows, 'bnb', (r) => ({ address: r.tokenAddress, symbol: r.tokenSymbol }))
    expect(out).toEqual(rows.map((r, i) => ({ ...r, lookalike: [usdtBnb, null, null][i] })))
  })
})
