import { describe, it, expect } from 'vitest'
import { getAddress } from 'ethers'
import { foldConfusables, lookalikeOf, lookalikeNote, WELL_KNOWN } from './lookalike'

// Confusable characters are written as \u escapes: they are visually identical to ASCII, so a
// literal one in this file would be unreadable in review (and look like a no-op test).
const CYR_TE = '\u0422' // Cyrillic capital Te, looks like T
const CYR_DZE = '\u0405' // Cyrillic capital Dze, looks like S
const ZWSP = '\u200B'
const ZWJ = '\u200D'

const BNB_USDT = '0x55d398326f99059fF775485246999027B3197955'
const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SPAM = '0x00000000000000000000000000000000deadbeef'

describe('foldConfusables', () => {
  it('folds Cyrillic and Greek homoglyphs, case, and the digit/letter swaps to plain ASCII', () => {
    expect(foldConfusables(`U5D${CYR_TE}`)).toBe('USDT')
    expect(foldConfusables(`USD${CYR_TE}`)).toBe('USDT')
    expect(foldConfusables(`U${CYR_DZE}DT`)).toBe('USDT')
    expect(foldConfusables('USD\u03A4')).toBe('USDT') // Greek capital Tau
    expect(foldConfusables('\u03A5ES')).toBe('YES') // Greek capital Upsilon looks like Y, not U
    expect(foldConfusables('usdt')).toBe('USDT')
    expect(foldConfusables('DAl')).toBe('DAI')
    expect(foldConfusables('DA1')).toBe('DAI')
    expect(foldConfusables('DA|')).toBe('DAI')
    expect(foldConfusables('B0B')).toBe('BOB')
  })

  it('NFKC-folds fullwidth letters', () => {
    expect(foldConfusables('\uFF35\uFF33\uFF24\uFF34')).toBe('USDT')
  })

  it('strips zero-width and other format characters, and whitespace', () => {
    expect(foldConfusables(`US${ZWSP}DT`)).toBe('USDT')
    expect(foldConfusables(`U${ZWJ}S\u2060D\uFEFFT`)).toBe('USDT')
    expect(foldConfusables('US\u00ADDT')).toBe('USDT') // soft hyphen
    expect(foldConfusables('U S\u00A0D T')).toBe('USDT')
    expect(foldConfusables('\u202EUSDT')).toBe('USDT') // right-to-left override
  })

  it('strips diacritics: accented letters and bare combining marks', () => {
    expect(foldConfusables('\u00DASDT')).toBe('USDT') // U with acute
    expect(foldConfusables('USD\u0164')).toBe('USDT') // T with caron
    expect(foldConfusables('U\u0301SDT')).toBe('USDT') // U + combining acute
    expect(foldConfusables('\u00DA\u0160D\u0164')).toBe('USDT')
    expect(foldConfusables('\u0407')).toBe('I') // Cyrillic Yi: Cyrillic I + diaeresis
  })

  it('leaves an ordinary symbol readable', () => {
    expect(foldConfusables('CAKE')).toBe('CAKE')
    expect(foldConfusables('')).toBe('')
  })
})

describe('lookalikeOf: flags', () => {
  const usdtBnb = { symbol: 'USDT', canonical: BNB_USDT }

  it.each([
    ['U5D + Cyrillic Te (the spam token on /token)', `U5D${CYR_TE}`],
    ['USD + Cyrillic Te', `USD${CYR_TE}`],
    ['U + Cyrillic Dze + DT', `U${CYR_DZE}DT`],
    ['fullwidth', '\uFF35\uFF33\uFF24\uFF34'],
    ['zero-width joined', `US${ZWSP}DT`],
    ['lowercase clone', 'usdt'],
  ])('reads %s as USDT on bnb', (_label, symbol) => {
    expect(lookalikeOf({ address: SPAM, symbol, name: 'whatever' }, 'bnb')).toEqual(usdtBnb)
  })

  it('flags a WBNB impostor on bnb', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'WBNB', name: 'x' }, 'bnb'))
      .toEqual({ symbol: 'WBNB', canonical: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' })
  })

  it('flags accented USDT clones', () => {
    for (const symbol of ['\u00DASDT', 'USD\u0164', 'U\u0301SDT']) {
      expect(lookalikeOf({ address: SPAM, symbol, name: 'x' }, 'bnb'), symbol).toEqual(usdtBnb)
    }
  })

  it('flags DAl (lowercase L) as DAI', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'DAl', name: 'x' }, 'bnb'))
      .toEqual({ symbol: 'DAI', canonical: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3' })
  })

  it("flags a token claiming the chain's native coin, with no canonical contract", () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'BNB', name: 'x' }, 'bnb')).toEqual({ symbol: 'BNB', canonical: null })
    expect(lookalikeOf({ address: SPAM, symbol: 'ETH', name: 'x' }, 'eth')).toEqual({ symbol: 'ETH', canonical: null })
  })

  it('flags by NAME when the symbol is unremarkable', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'Tether USD' }, 'bnb')).toEqual(usdtBnb)
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: `Tether${ZWSP} U${CYR_DZE}D` }, 'bnb')).toEqual(usdtBnb)
  })

  it('flags a token at the OTHER chain\'s canonical address', () => {
    // 0x55d3… is BNB Chain USDT; on Ethereum it is just another contract wearing the name.
    expect(lookalikeOf({ address: BNB_USDT, symbol: 'USDT', name: 'Tether USD' }, 'eth'))
      .toEqual({ symbol: 'USDT', canonical: ETH_USDT })
    expect(lookalikeOf({ address: ETH_USDT, symbol: 'USDT', name: 'Tether USD' }, 'bnb'))
      .toEqual({ symbol: 'USDT', canonical: BNB_USDT })
  })

  it('has the per-chain tokens each chain is expected to protect', () => {
    const symbols = (c: 'bnb' | 'eth') => WELL_KNOWN[c].map((w) => w.symbol)
    expect(symbols('bnb')).toEqual(['USDT', 'USDC', 'BUSD', 'DAI', 'WBNB', 'ETH', 'BTCB', 'BNB'])
    expect(symbols('eth')).toEqual(['USDT', 'USDC', 'DAI', 'WETH', 'WBTC', 'BUSD', 'BNB', 'ETH'])
    // WBTC is an Ethereum token with no BNB Chain entry, and BTCB the reverse.
    expect(lookalikeOf({ address: SPAM, symbol: 'WBTC', name: 'x' }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: 'BTCB', name: 'x' }, 'eth')).toBeNull()
  })
})

describe('lookalikeOf: does not flag', () => {
  it('the canonical contract itself, in any address casing', () => {
    for (const a of [BNB_USDT, BNB_USDT.toLowerCase(), BNB_USDT.toUpperCase().replace('0X', '0x')]) {
      expect(lookalikeOf({ address: a, symbol: 'USDT', name: 'Tether USD' }, 'bnb')).toBeNull()
    }
    expect(lookalikeOf({ address: ETH_USDT.toLowerCase(), symbol: 'USDT', name: 'Tether USD' }, 'eth')).toBeNull()
  })

  it('every canonical token, as the chain itself reports it', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      for (const w of WELL_KNOWN[chain]) {
        if (!w.address) continue
        expect(lookalikeOf({ address: w.address, symbol: w.symbol, name: w.name }, chain), `${chain} ${w.symbol}`).toBeNull()
        expect(lookalikeOf({ address: w.address.toLowerCase(), symbol: w.symbol, name: w.name }, chain)).toBeNull()
      }
    }
  })

  it('an unrelated token', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'CAKE', name: 'PancakeSwap Token' }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: 'USDT0', name: 'USDT Zero' }, 'bnb')).toBeNull()
  })

  it('a missing, empty or placeholder symbol and name', () => {
    expect(lookalikeOf({ address: SPAM, symbol: null, name: null }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: '', name: '' }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: '???', name: 'Unknown' }, 'bnb')).toBeNull()
  })
})

describe('WELL_KNOWN', () => {
  it('holds only valid EIP-55 checksummed addresses', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      for (const w of WELL_KNOWN[chain]) {
        if (w.address) expect(getAddress(w.address), `${chain} ${w.symbol}`).toBe(w.address)
      }
    }
  })
})

describe('lookalikeNote', () => {
  it('names the real contract, shortened', () => {
    expect(lookalikeNote({ symbol: 'USDT', canonical: BNB_USDT }))
      .toBe('Its symbol or name reads as USDT, but this is not the USDT contract (0x55d3…7955). Likely impersonation.')
  })

  it("says the native coin has no contract", () => {
    expect(lookalikeNote({ symbol: 'BNB', canonical: null }))
      .toBe("Its symbol or name reads as BNB, which is the chain's native coin and has no token contract. Likely impersonation.")
  })
})
