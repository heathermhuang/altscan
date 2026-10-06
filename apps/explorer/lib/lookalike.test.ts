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

  it('folds a lowercase letter whose UPPERCASE is the homoglyph', () => {
    expect(foldConfusables('USD\u0442')).toBe('USDT') // Cyrillic small te
    expect(foldConfusables('DA\u03B9')).toBe('DAI') // Greek small iota
    expect(foldConfusables('USD\u03C4')).toBe('USDT') // Greek small tau
    expect(foldConfusables('BTC\u0432')).toBe('BTCB') // Cyrillic small ve
    expect(foldConfusables('BTC\u043A')).toBe('BTCK') // Cyrillic small ka reads as K, not B
    expect(foldConfusables('\u0432\u043C\u043D')).toBe('BMH') // small ve em en
    expect(foldConfusables('\u03B1\u03C1\u03B5\u03BA\u03C5\u03C7')).toBe('APEKYX') // small alpha rho epsilon kappa upsilon chi
    expect(foldConfusables('\u03BD')).toBe('V') // Greek small nu keeps reading as v
  })

  it('strips blank filler letters and folds the palochka to I', () => {
    for (const filler of ['\u3164', '\uFFA0', '\u115F', '\u1160', '\u2800']) {
      expect(foldConfusables(`US${filler}DT`), filler.charCodeAt(0).toString(16)).toBe('USDT')
    }
    expect(foldConfusables('DA\u04CF')).toBe('DAI') // Cyrillic small palochka
    expect(foldConfusables('DA\u04C0')).toBe('DAI') // Cyrillic capital palochka
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

  it('flags a clone whose homoglyph is lowercase', () => {
    for (const symbol of ['USD\u0442', 'USD\u03C4']) {
      expect(lookalikeOf({ address: SPAM, symbol, name: 'x' }, 'bnb'), symbol).toEqual(usdtBnb)
    }
    expect(lookalikeOf({ address: SPAM, symbol: 'DA\u03B9', name: 'x' }, 'bnb'))
      .toEqual({ symbol: 'DAI', canonical: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3' })
    expect(lookalikeOf({ address: SPAM, symbol: 'BTC\u0432', name: 'x' }, 'bnb'))
      .toEqual({ symbol: 'BTCB', canonical: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c' })
  })

  it('flags a clone padded with an invisible filler or a palochka', () => {
    for (const symbol of ['US\u3164DT', 'US\u2800DT', 'US\uFFA0DT', 'US\u115FDT', 'US\u1160DT']) {
      expect(lookalikeOf({ address: SPAM, symbol, name: 'x' }, 'bnb'), symbol).toEqual(usdtBnb)
    }
    expect(lookalikeOf({ address: SPAM, symbol: 'DA\u04CF', name: 'x' }, 'bnb')?.symbol).toBe('DAI')
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

// Real spam from the 2026-10 tokens tables, byte for byte (U+0358 combining dot above right, U+1E6C T with
// dot below, U+1E0C D with dot below, U+1EA0 A with dot below, U+00DA U acute, U+0405 Cyrillic Dze).
describe('lookalikeOf: real spam seen in production', () => {
  const canon = (chain: 'bnb' | 'eth', symbol: string) => WELL_KNOWN[chain].find((w) => w.symbol === symbol)?.address
  it.each([
    ['BNB Binance-Peg BSC-USD, 22k holders', 'bnb', '0xacfcace43b613c3ab3f71fab72c0b58e35c76dff', 'BSC-USD', 'Binance-Peg BSC-USD', 'USDT'],
    ['BNB Binance-Peg Ethereum Token with marks', 'bnb', '0xea858f4b8d915d35b25f5f63d35ab50f8e505230', 'E\u1E6CH', 'Bi\u0358nance-Peg Ethereum \u1E6Coken', 'ETH'],
    ['BNB USD Coin with marks', 'bnb', '0xc6b811aa7d4a0ed9031ba25d2de538d4cc89a536', 'US\u1E0CC', 'USD Coi\u0358n', 'USDC'],
    ['ETH USDT with marks', 'eth', '0xfbfeec01ab2e14e8fad50265f00c7cb7b094f9a2', 'USD\u0358T\u0358', 'USD\u0358T\u0358', 'USDT'],
    ['ETH USDC with acute U and Cyrillic Dze', 'eth', '0x2b13366e28eef0c6dbee008091c9cfa4140ec64d', '\u00DA\u0405DC', '\u00DA\u0405D Coin', 'USDC'],
    ['ETH ERC20:USDT', 'eth', '0x062a1a272656ae25e2a0d75a39501053ae03db44', 'USDT', 'ERC20:USDT', 'USDT'],
    ['ETH DAI with dot below', 'eth', '0x4c0c5733107a48ea0e741aad768d12bca5c61ae7', 'D\u1EA0I', 'D\u1EA0I', 'DAI'],
  ] as const)('%s', (_label, chain, address, symbol, name, target) => {
    expect(lookalikeOf({ address, symbol, name }, chain)).toEqual({ symbol: target, canonical: canon(chain, target) })
  })

  it('catches the BscScan label of the real USDT on either field alone', () => {
    const usdt = { symbol: 'USDT', canonical: BNB_USDT }
    expect(lookalikeOf({ address: SPAM, symbol: 'BSC-USD', name: 'x' }, 'bnb')).toEqual(usdt)
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'Binance-Peg BSC-USD' }, 'bnb')).toEqual(usdt)
  })

  it('catches "Binance-Peg <name>" for every BNB Chain contract, by name alone', () => {
    for (const w of WELL_KNOWN.bnb) {
      if (!w.address) continue
      expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: `Binance-Peg ${w.name}` }, 'bnb')?.symbol, w.symbol).toBe(w.symbol)
    }
  })

  it('catches a marked-up "Binance-Peg" name by name alone', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'Bi\u0358nance-Peg Ethereum \u1E6Coken' }, 'bnb')?.symbol).toBe('ETH')
  })

  it('does not apply BscScan\'s peg labels on Ethereum', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'Binance-Peg BSC-USD' }, 'eth')).toBeNull()
  })

  it('does not flag a Binance-Peg token that is not a well-known one', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XRP', name: 'Binance-Peg XRP Token' }, 'bnb')).toBeNull()
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
    // Real tokens one character from a well-known one.
    for (const [symbol, name] of [
      ['USD1', 'World Liberty Financial USD'],
      ['USDe', 'USDe'],
      ['stETH', 'Liquid staked Ether 2.0'],
      ['ETHW', 'EthereumPoW'],
      ['sDAI', 'Savings Dai'],
    ]) {
      expect(lookalikeOf({ address: SPAM, symbol, name }, 'bnb'), symbol).toBeNull()
    }
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
