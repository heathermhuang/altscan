import { describe, it, expect, vi } from 'vitest'
import { getAddress } from 'ethers'
import { foldConfusables, lookalikeOf, lookalikeNote, HOMOGLYPHS, WELL_KNOWN } from './lookalike'

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
    expect(foldConfusables('\u03B1\u03C1\u03B5\u03BA\u03C5\u03C7')).toBe('APEKUX') // small alpha rho epsilon kappa upsilon chi: the table reads small upsilon as u
    expect(foldConfusables('\u03BD')).toBe('V') // Greek small nu keeps reading as v
  })

  it('strips blank filler letters and folds the palochka to I', () => {
    for (const filler of ['\u3164', '\uFFA0', '\u115F', '\u1160', '\u2800']) {
      expect(foldConfusables(`US${filler}DT`), filler.charCodeAt(0).toString(16)).toBe('USDT')
    }
    expect(foldConfusables('DA\u04CF')).toBe('DAI') // Cyrillic small palochka
    expect(foldConfusables('DA\u04C0')).toBe('DAI') // Cyrillic capital palochka
  })

  // Unicode confusables.txt (2026-08-06): Lisu letters whose prototype is one Latin capital letter.
  it('folds every Lisu letter the confusables table maps to a Latin capital', () => {
    const lisu: [number, string][] = [
      [0xA4EE, 'A'], [0xA4D0, 'B'], [0xA4DA, 'C'], [0xA4D3, 'D'], [0xA4F0, 'E'], [0xA4DD, 'F'],
      [0xA4D6, 'G'], [0xA4E7, 'H'], [0xA4D9, 'J'], [0xA4D7, 'K'], [0xA4E1, 'L'], [0xA4DF, 'M'],
      [0xA4E0, 'N'], [0xA4F3, 'O'], [0xA4D1, 'P'], [0xA4E3, 'R'], [0xA4E2, 'S'], [0xA4D4, 'T'],
      [0xA4F4, 'U'], [0xA4E6, 'V'], [0xA4EA, 'W'], [0xA4EB, 'X'], [0xA4EC, 'Y'], [0xA4DC, 'Z'],
    ]
    for (const [cp, letter] of lisu) expect(foldConfusables(String.fromCodePoint(cp)), cp.toString(16)).toBe(letter)
    expect(foldConfusables('DA\uA4F2')).toBe('DAI') // Lisu letter I: the table gives small l
    expect(foldConfusables('\uA4D2')).toBe('D') // Lisu letter Pha: the table gives small d
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
  const canon = (chain: 'bnb' | 'eth', symbol: string) => WELL_KNOWN[chain].find((w) => w.symbol === symbol)?.addresses[0] ?? null
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
      if (!w.addresses.length) continue
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

// Real spam in the local index: U+206F (format character) between letters, and a Lisu letter for a Latin one.
describe('lookalikeOf: format characters and Lisu letters', () => {
  const NOMINAL_DIGITS = '\u206F'
  const spaced = (...letters: string[]) => letters.join(NOMINAL_DIGITS)
  it('flags U+206F-spaced USDC with a Lisu Ca, as the BNB spam token', () => {
    const spam = spaced('U', 'S', 'D\uA4DA')
    expect(lookalikeOf({ address: '0x086e8e227df3e7497b9d517bb86ad1c240ace190', symbol: spam, name: spam }, 'bnb'))
      .toEqual({ symbol: 'USDC', canonical: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' })
  })

  it('flags U+206F-spaced USDT with a Greek Tau', () => {
    const spam = spaced('U', 'S', 'D\u03A4')
    expect(lookalikeOf({ address: SPAM, symbol: spam, name: spam }, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
  })

  it('flags U+206F-spaced BNB as the native coin', () => {
    const spam = spaced('B', 'N', 'B')
    expect(lookalikeOf({ address: SPAM, symbol: spam, name: spam }, 'bnb')).toEqual({ symbol: 'BNB', canonical: null })
  })

  it('flags a spelling made only of Lisu letters (U, S, D, T)', () => {
    const spam = '\uA4F4\uA4E2\uA4D3\uA4D4'
    expect(lookalikeOf({ address: SPAM, symbol: spam, name: 'x' }, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
  })
})

// The glyph table is generated from Unicode's confusables.txt (UTS #39 v18.0.0, 2026-08-06): every entry whose
// source is one non-ASCII code point and whose prototype is one Latin letter, except long s (U+017F). NFKD folding
// an entry does NOT keep it out: the repo pins no Node version, and an older runtime's Unicode data lacks the
// newest characters. Families are in the source's order, and an entry counts toward the FIRST family whose
// ranges hold it, so a later, wider family is "the rest" of its ranges.
describe('HOMOGLYPHS', () => {
  const FAMILIES: { name: string; ranges: [number, number][]; count: number }[] = [
    { name: 'Warang Citi', ranges: [[0x118a0, 0x118ff]], count: 27 },
    { name: 'Canadian Syllabics', ranges: [[0x1400, 0x167f], [0x11ab0, 0x11abf]], count: 22 },
    {
      name: 'Latin and IPA', count: 61,
      ranges: [[0x80, 0x2af], [0x1d00, 0x1eff], [0x2c60, 0x2c7f], [0xa720, 0xa7ff], [0xab30, 0xab6f], [0x1df00, 0x1dfff]],
    },
    { name: 'Greek and Coptic', ranges: [[0x370, 0x3ff]], count: 32 },
    { name: 'Cyrillic', ranges: [[0x400, 0x4ff]], count: 38 },
    { name: 'Cyrillic Supplement and Extended', ranges: [[0x500, 0x52f], [0x1c80, 0x1c8f], [0xa640, 0xa69f]], count: 9 },
    { name: 'Armenian', ranges: [[0x530, 0x58f]], count: 15 },
    {
      name: 'Hebrew, Arabic, NKo and Mandaic', count: 42,
      ranges: [[0x590, 0x8ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff], [0x1ee00, 0x1eeff]],
    },
    { name: 'Indic scripts', ranges: [[0x900, 0xdff], [0x1cd0, 0x1cff], [0xa830, 0xa8df], [0x11000, 0x11fff]], count: 39 },
    { name: 'Southeast Asian scripts', ranges: [[0xe00, 0x109f], [0x1700, 0x1bff], [0xaa00, 0xaa5f]], count: 15 },
    { name: 'Georgian', ranges: [[0x10a0, 0x10ff], [0x1c90, 0x1cbf], [0x2d00, 0x2d2f]], count: 9 },
    { name: 'Hangul Jamo and Ethiopic', ranges: [[0x1100, 0x137f]], count: 4 },
    { name: 'Cherokee', ranges: [[0x13a0, 0x13ff], [0xab70, 0xabbf]], count: 36 },
    { name: 'Runic', ranges: [[0x16a0, 0x16ff]], count: 5 },
    { name: 'Coptic', ranges: [[0x2c80, 0x2cff]], count: 24 },
    { name: 'Tifinagh', ranges: [[0x2d30, 0x2d7f]], count: 7 },
    { name: 'Lisu', ranges: [[0xa4d0, 0xa4ff]], count: 26 },
    { name: 'Vai and Bamum', ranges: [[0xa500, 0xa63f], [0xa6a0, 0xa6ff], [0x16800, 0x16a3f]], count: 8 },
    { name: 'CJK, Bopomofo and Hangul compatibility', ranges: [[0x3100, 0x9fff]], count: 5 },
    { name: 'Letterlike symbols and number forms', ranges: [[0x2100, 0x218f]], count: 46 },
    { name: 'Fullwidth and halfwidth forms', ranges: [[0xff00, 0xffef]], count: 56 },
    { name: 'Outlined and segmented letters and digits', ranges: [[0x1cc00, 0x1cebf], [0x1fb00, 0x1fbff]], count: 30 },
    {
      name: 'Symbols, punctuation and numerals', count: 39,
      ranges: [
        [0x2190, 0x2bff], [0x3000, 0x303f], [0xfe30, 0xfe4f], [0x10140, 0x1018f], [0x102e0, 0x102ff],
        [0x1cec0, 0x1ceff], [0x1d100, 0x1d3ff], [0x1ed00, 0x1ed4f], [0x1f700, 0x1f7ff],
      ],
    },
    { name: 'Historic scripts', ranges: [[0x10000, 0x10fff]], count: 65 },
    { name: 'Mathematical alphanumerics', ranges: [[0x1d400, 0x1d7ff]], count: 767 },
    { name: 'Other supplementary-plane scripts', ranges: [[0x10000, 0x1ffff]], count: 19 },
  ]
  const familyOf = (cp: number) => FAMILIES.find((f) => f.ranges.some(([lo, hi]) => cp >= lo && cp <= hi))
  const entries = Object.entries(HOMOGLYPHS).map(([ch, letter]) => ({ ch, letter, cp: ch.codePointAt(0) as number }))
  const hexOf = (cp: number) => `U+${cp.toString(16).toUpperCase()}`

  it('holds 1446 entries: single non-ASCII characters, each valued one uppercase Latin letter', () => {
    expect(entries).toHaveLength(1446)
    expect(FAMILIES.reduce((n, f) => n + f.count, 0)).toBe(1446)
    for (const e of entries) {
      expect([...e.ch], hexOf(e.cp)).toHaveLength(1)
      expect(e.cp, hexOf(e.cp)).toBeGreaterThan(0x7f)
      expect(e.letter, hexOf(e.cp)).toMatch(/^[A-Z]$/)
      expect(familyOf(e.cp), hexOf(e.cp)).toBeDefined()
    }
  })

  it('pins the count per script family (Greek and Coptic, Cyrillic and Lisu are #196\'s 32, 38 and 26)', () => {
    for (const f of FAMILIES) {
      expect(entries.filter((e) => familyOf(e.cp) === f).length, f.name).toBe(f.count)
    }
  })

  it('folds every entry to its prototype through the whole pipeline (NFKD included)', () => {
    for (const e of entries) {
      expect(foldConfusables(e.ch), hexOf(e.cp)).toBe(e.letter)
      expect(foldConfusables(`US${e.ch}`), `US + ${hexOf(e.cp)}`).toBe(`US${e.letter}`)
    }
  })

  // The ordering bug class: NFKD rewrites these sources (a presentation form to the plain letter it
  // is a form of, a halfwidth form to its jamo or box line) into something the table does not hold, so
  // the table has to see the raw text first.
  it('folds the entries NFKD would rewrite before the table sees them', () => {
    const rewritten = entries.filter((e) => e.ch.normalize('NFKD') !== e.ch)
    expect(rewritten.length).toBeGreaterThan(0)
    for (const e of rewritten) {
      expect(foldConfusables(e.ch), hexOf(e.cp)).toBe(e.letter)
    }
    expect(foldConfusables('\uFE8D')).toBe('I') // Arabic isolated alef: NFKD makes it U+0627, which the table lacks
    expect(foldConfusables('\u3147')).toBe('O') // Hangul ieung: NFKD makes it the jamo U+110B
  })

  // The repo pins no Node version, so the fold must not lean on the runtime's Unicode data. Replacing normalize()
  // with the identity is the oldest runtime there could be: it knows no character that NFKD would rewrite.
  const withoutNormalize = <T>(fn: () => T): T => {
    const spy = vi.spyOn(String.prototype, 'normalize').mockImplementation(function (this: string) { return String(this) })
    try { return fn() } finally { spy.mockRestore() }
  }

  it('folds every entry on its own: the same answer with a normalize() that rewrites nothing', () => {
    const wrong = withoutNormalize(() => entries
      .filter((e) => foldConfusables(e.ch) !== e.letter || foldConfusables(`US${e.ch}`) !== `US${e.letter}`)
      .map((e) => hexOf(e.cp)))
    expect(wrong).toEqual([])
  })

  it('holds the sources NFKD also folds: fullwidth, mathematical, roman numeral, outlined, dotless', () => {
    for (const [ch, letter] of [
      ['\uFF21', 'A'], // fullwidth A
      ['\u{1D400}', 'A'], // mathematical bold A
      ['\u{1D6A8}', 'A'], // mathematical bold Alpha: NFKD makes it Greek Alpha
      ['\u2160', 'I'], // roman numeral one
      ['\u0131', 'I'], // dotless i
      ['\u{1CCD6}', 'A'], // outlined Latin A (Unicode 16)
      ['\u{1CCEF}', 'Z'], // outlined Latin Z (Unicode 16)
    ] as const) {
      expect(HOMOGLYPHS[ch], hexOf(ch.codePointAt(0) as number)).toBe(letter)
    }
  })

  it('leaves out ASCII sources (the fold swaps 0, 1, I and | itself) and long s', () => {
    for (const ch of ['0', '1', 'I', 'l', '|', '\u017F']) {
      expect(HOMOGLYPHS[ch], ch).toBeUndefined()
    }
    expect(foldConfusables('\u017F')).toBe('S') // NFKD reads s where UTS #39 says f
    expect(lookalikeOf({ address: SPAM, symbol: 'U\u017FDT', name: 'x' }, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
  })

  // Outlined Latin letters are Unicode 16: a Node whose ICU is newer folds them with NFKD, an older one (Node 18) does not.
  it('flags outlined-letter USDT on a runtime that does not know them, and on one that does', () => {
    const outlined = '\u{1CCEA}\u{1CCE8}\u{1CCD9}\u{1CCE9}' // outlined Latin U S D T
    const token = { address: SPAM, symbol: outlined, name: 'x' }
    expect(foldConfusables(outlined)).toBe('USDT')
    expect(lookalikeOf(token, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
    expect(withoutNormalize(() => foldConfusables(outlined))).toBe('USDT')
    expect(withoutNormalize(() => lookalikeOf(token, 'bnb'))).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
    expect(withoutNormalize(() => lookalikeOf({ address: SPAM, symbol: 'XYZ', name: outlined }, 'eth')))
      .toEqual({ symbol: 'USDT', canonical: '0xdAC17F958D2ee523a2206206994597C13D831ec7' })
  })

  it('reads Greek small upsilon as U, and flags it as USDT', () => {
    expect(foldConfusables('\u03C5SDT')).toBe('USDT')
    expect(foldConfusables('\u03A5SDT')).toBe('YSDT') // capital Upsilon still reads as Y
    expect(lookalikeOf({ address: SPAM, symbol: '\u03C5SDT', name: 'x' }, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
  })

  it('reads the lunate sigma as C, so a lunate USDC is flagged (NFKD would turn it into a sigma)', () => {
    expect(foldConfusables('US D\u03F9')).toBe('USDC') // capital lunate sigma
    expect(foldConfusables('USD\u03F2')).toBe('USDC') // small lunate sigma
    expect(lookalikeOf({ address: SPAM, symbol: 'US D\u03F9', name: 'x' }, 'bnb'))
      .toEqual({ symbol: 'USDC', canonical: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' })
  })

  it('folds Cyrillic straight U to Y and Cyrillic shha to H', () => {
    expect(foldConfusables('\u04AE\u04AF')).toBe('YY')
    expect(foldConfusables('\u04BA\u04BB')).toBe('HH')
    expect(lookalikeOf({ address: SPAM, symbol: 'ET\u04BB', name: 'x' }, 'eth')).toEqual({ symbol: 'ETH', canonical: null })
    expect(lookalikeOf({ address: SPAM, symbol: 'ET\u04BA', name: 'x' }, 'bnb')).toEqual({ symbol: 'ETH', canonical: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8' })
  })
})

// A token NAMED "USDT" is shown as "USDT" whatever its symbol says, so a name equal to a well-known SYMBOL
// (or to one of its aliases) is flagged like a name equal to its full name.
describe('lookalikeOf: name equals a well-known symbol', () => {
  const usdtBnb = { symbol: 'USDT', canonical: BNB_USDT }

  it.each([
    ['plain', 'USDT'],
    ['lowercase', 'usdt'],
    ['Cyrillic Te and digit five', `U5D${CYR_TE}`],
    ['zero-width joined', `US${ZWSP}DT`],
    ['BscScan symbol alias', 'BSC-USD'],
  ])('flags a token named %s as USDT on bnb, whatever its symbol', (_label, name) => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name }, 'bnb')).toEqual(usdtBnb)
  })

  it('flags a name that is the symbol of a token with an alias-only match, on the right chain', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'DAI' }, 'eth'))
      .toEqual({ symbol: 'DAI', canonical: '0x6B175474E89094C44Da98b954EedeAC495271d0F' })
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'WBTC' }, 'eth'))
      .toEqual({ symbol: 'WBTC', canonical: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' })
  })

  it("flags a name that is the native coin's symbol, with no canonical contract", () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'BNB' }, 'bnb')).toEqual({ symbol: 'BNB', canonical: null })
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'ETH' }, 'eth')).toEqual({ symbol: 'ETH', canonical: null })
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'ETH' }, 'bnb'))
      .toEqual({ symbol: 'ETH', canonical: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8' })
  })

  it('does not flag a name that is only a symbol on the OTHER chain', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'WBTC' }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'BTCB' }, 'eth')).toBeNull()
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'BSC-USD' }, 'eth')).toBeNull()
  })

  it('does not flag a name that merely contains or extends a symbol', () => {
    for (const [symbol, name] of [
      ['stETH', 'ETH Staking'],
      ['ETH2', 'ETH 2.0'],
      ['USDT0', 'USDT Zero'],
      ['sDAI', 'Savings DAI'],
      ['WBNB2', 'WBNB v2'],
      ['XYZ', 'My BNB'],
    ]) {
      expect(lookalikeOf({ address: SPAM, symbol, name }, 'bnb'), name).toBeNull()
      expect(lookalikeOf({ address: SPAM, symbol, name }, 'eth'), name).toBeNull()
    }
  })

  it('does not flag the canonical contract itself, even with the name set to the symbol', () => {
    expect(lookalikeOf({ address: BNB_USDT, symbol: 'USDT', name: 'USDT' }, 'bnb')).toBeNull()
    expect(lookalikeOf({ address: ETH_USDT, symbol: 'XYZ', name: 'USDT' }, 'eth')).toBeNull()
  })
})

// Spellings in the scripts #196 did not cover. Each is a symbol or name a spammer could paste, written as
// \u escapes: a letter from Cherokee, Armenian, the Cyrillic Supplement, Canadian Syllabics, Warang Citi,
// the phonetic small capitals or Coptic, in place of the Latin one.
describe('lookalikeOf: scripts beyond Greek, Cyrillic and Lisu', () => {
  const bnb = (symbol: string) => WELL_KNOWN.bnb.find((w) => w.symbol === symbol)?.addresses[0] ?? null
  const eth = (symbol: string) => WELL_KNOWN.eth.find((w) => w.symbol === symbol)?.addresses[0] ?? null
  it.each([
    ['Cherokee Gv, I, Mi (ETH, all Cherokee)', '\u13AC\u13A2\u13BB', 'ETH'],
    ['Cherokee A, Go, V (DAI, all Cherokee)', '\u13A0\u13AA\u13A5', 'DAI'],
    ['Armenian Seh, Cherokee Du, A, I (USDT)', '\u054D\u13DA\u13A0\u13A2', 'USDT'],
    ['Cherokee Yv, Armenian small Vo, Cherokee Yv (BNB)', '\u13F4\u0578\u13F4', 'BNB'],
    ['Cherokee Supplement small Du and Tli for the S and C of USDC', 'U\uABAAD\uABAF', 'USDC'],
    ['Armenian Tiwn for the S of USDT', 'U\u054FDT', 'USDT'],
    ['Cyrillic Komi De for the D of BUSD', 'BUS\u0501', 'BUSD'],
    ['Cyrillic Komi De for the D of DAI', '\u0501AI', 'DAI'],
    ['Canadian Syllabics Te, Latin S, Carrier Pe, Latin T (USDT)', '\u144CS\u15EAT', 'USDT'],
    ['Canadian Syllabics Carrier Khe, Te, Latin S, Carrier Pe (BUSD)', '\u15F7\u144CS\u15EA', 'BUSD'],
    ['Warang Citi Pu, Warang Citi small A, Latin D, Warang Citi Har (USDT)', '\u{118B8}\u{118C1}D\u{118BC}', 'USDT'],
    ['phonetic small capital U and S (USDT)', '\u1D1C\uA731DT', 'USDT'],
    ['Coptic Sima for the C of USDC', 'USD\u2CA4', 'USDC'],
    ['Coptic Tau for the T of USDT', 'USD\u2CA6', 'USDT'],
  ])('reads %s as the well-known token', (_label, symbol, target) => {
    const canonical = bnb(target)
    expect(lookalikeOf({ address: SPAM, symbol, name: 'x' }, 'bnb'), symbol).toEqual({ symbol: target, canonical })
  })

  it('reads the same spellings by NAME alone, and on the Ethereum table', () => {
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: 'USD C\u0555in' }, 'bnb')) // Armenian Oh for the o of Coin
      .toEqual({ symbol: 'USDC', canonical: bnb('USDC') })
    expect(lookalikeOf({ address: SPAM, symbol: 'XYZ', name: '\u13AC\u13A2\u13BB' }, 'eth'))
      .toEqual({ symbol: 'ETH', canonical: null })
    expect(lookalikeOf({ address: SPAM, symbol: '\u054D\u13DA\u13A0\u13A2', name: 'x' }, 'eth'))
      .toEqual({ symbol: 'USDT', canonical: eth('USDT') })
  })

  it('does not flag a word in one of these scripts that folds to something else', () => {
    // Cherokee, Armenian and Canadian Syllabics words: all fold to Latin letters, none to a well-known symbol.
    for (const word of ['\u13A0\u13A2\u13A3', '\u054D\u0561\u0566', '\u144C\u15EA\u15EA']) {
      expect(lookalikeOf({ address: SPAM, symbol: word, name: word }, 'bnb'), word).toBeNull()
      expect(lookalikeOf({ address: SPAM, symbol: word, name: word }, 'eth'), word).toBeNull()
    }
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
        for (const address of w.addresses) {
          expect(lookalikeOf({ address, symbol: w.symbol, name: w.name }, chain), `${chain} ${w.symbol}`).toBeNull()
          expect(lookalikeOf({ address: address.toLowerCase(), symbol: w.symbol, name: w.name }, chain)).toBeNull()
        }
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
  it('holds only valid EIP-55 checksummed addresses, none twice on a chain', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      const seen = new Set<string>()
      for (const w of WELL_KNOWN[chain]) {
        for (const address of w.addresses) {
          expect(getAddress(address), `${chain} ${w.symbol}`).toBe(address)
          expect(seen.has(address.toLowerCase()), `${chain} ${address} listed twice`).toBe(false)
          seen.add(address.toLowerCase())
        }
      }
    }
  })

  it('gives the native coin no address and every other token at least one', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      const native = chain === 'bnb' ? 'BNB' : 'ETH'
      for (const w of WELL_KNOWN[chain]) {
        if (w.symbol === native && w.addresses.length === 0) continue
        expect(w.addresses.length, `${chain} ${w.symbol}`).toBeGreaterThan(0)
      }
      expect(WELL_KNOWN[chain].filter((w) => w.addresses.length === 0).map((w) => w.symbol)).toEqual([native])
    }
  })

  it('compares a token against EVERY address of the well-known token it reads as', () => {
    // FOLDED copies the entry with a spread, so it shares this addresses array: pushing one in
    // here is what a second real deployment in the table would look like. Restored in finally.
    const usdt = WELL_KNOWN.bnb[0]
    const second = '0x00000000000000000000000000000000C0ffee01'
    const token = { address: second, symbol: 'USDT', name: 'Tether USD' }
    expect(lookalikeOf(token, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
    ;(usdt.addresses as string[]).push(second)
    try {
      expect(lookalikeOf(token, 'bnb')).toBeNull()
      expect(lookalikeOf({ ...token, address: second.toLowerCase() }, 'bnb')).toBeNull()
      expect(lookalikeOf({ ...token, address: BNB_USDT }, 'bnb')).toBeNull() // the first still counts
      expect(lookalikeOf({ ...token, address: SPAM }, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT }) // canonical stays the primary
    } finally {
      ;(usdt.addresses as string[]).pop()
    }
    expect(lookalikeOf(token, 'bnb')).toEqual({ symbol: 'USDT', canonical: BNB_USDT })
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
