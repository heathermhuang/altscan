import { describe, it, expect } from 'vitest'
import { rankTokenMatches, SEARCH_RESULT_LIMIT } from './token-search-rank'

type Row = { address: string; name: string; symbol: string; holderCount: number }
let n = 0
const row = (symbol: string, name: string, holderCount = 0, address?: string): Row => ({
  address: address ?? `0x${(++n).toString(16).padStart(40, '0')}`,
  symbol, name, holderCount,
})
const none = () => false
const syms = (rows: Row[]) => rows.map((r) => r.symbol)

describe('rankTokenMatches tiers', () => {
  it('orders exact symbol, exact name, symbol prefix, name prefix, contains — whatever the holder counts', () => {
    const contains = row('XTUSD', 'Some Dollar', 9_000_000)
    const namePrefix = row('AAA', 'Usd Reserve', 8_000_000)
    const symPrefix = row('USDX', 'Another', 7_000_000)
    const exactName = row('TTT', 'USD', 6_000_000)
    const exactSym = row('USD', 'Plain', 1)
    expect(rankTokenMatches([contains, namePrefix, symPrefix, exactName, exactSym], 'usd', none))
      .toEqual([exactSym, exactName, symPrefix, namePrefix, contains])
  })

  it('matches case-insensitively in both directions', () => {
    const lower = row('usdt', 'x', 1)
    const upper = row('USDT', 'x', 2)
    const other = row('USDTX', 'x', 3)
    expect(rankTokenMatches([other, lower, upper], 'UsDt', none).slice(0, 2)).toEqual([upper, lower])
  })

  it('ignores whitespace around the query and around the stored text', () => {
    const exact = row(' USDT ', 'x', 1)
    const prefix = row('USDTX', 'x', 99)
    expect(rankTokenMatches([prefix, exact], '  usdt ', none)[0]).toBe(exact)
  })

  it('treats a token that is only a substring match as the weakest tier', () => {
    const inner = row('ABC', 'My Tether Dollar', 500)
    const prefix = row('ABD', 'Tether Dollar', 1)
    expect(rankTokenMatches([inner, prefix], 'tether', none)).toEqual([prefix, inner])
  })
})

describe('rankTokenMatches lookalikes', () => {
  it('puts a non-lookalike before a lookalike even when the lookalike has far more holders', () => {
    const fake = row('USDT', 'Tether USD', 5_000_000)
    const real = row('USDT', 'Tether USD', 40)
    expect(rankTokenMatches([fake, real], 'usdt', (t) => t === fake)).toEqual([real, fake])
  })

  it('orders by holder count descending inside each lookalike class', () => {
    const a = row('USDT', 'a', 10)
    const b = row('USDT', 'b', 300)
    const c = row('USDT', 'c', 20)
    const fakeLow = row('USDT', 'd', 5)
    const fakeHigh = row('USDT', 'e', 50)
    const fakes = new Set([fakeLow, fakeHigh])
    expect(rankTokenMatches([a, fakeLow, b, fakeHigh, c], 'usdt', (t) => fakes.has(t)))
      .toEqual([b, c, a, fakeHigh, fakeLow])
  })

  it('ranks every real token above every lookalike, whatever the tier: a clean prefix beats a lookalike exact symbol', () => {
    const fakeExact = row('USDT', 'x', 5_000_000)
    const cleanPrefix = row('USDTX', 'x', 1)
    expect(rankTokenMatches([fakeExact, cleanPrefix], 'usdt', (t) => t === fakeExact)).toEqual([cleanPrefix, fakeExact])
  })

  it('ranks a clean contains-match above a lookalike exact symbol (the weakest real token still wins)', () => {
    const fakeExact = row('USDT', 'Tether USD', 9_000_000)
    const cleanInner = row('VUSDT', 'Venus USDT', 3)
    expect(rankTokenMatches([fakeExact, cleanInner], 'usdt', (t) => t === fakeExact)).toEqual([cleanInner, fakeExact])
  })

  it('the production case: lookalikes named exactly "Tether" rank below the canonical "Tether USD"', () => {
    // /search?q=tether on both chains: three tokens NAMED "Tether" (an exact-name match) outranked the
    // canonical contract, whose name "Tether USD" is only a name-prefix match.
    const canonical = row('USDT', 'Tether USD', 5_000_000, '0x55d398326f99059ff775485246999027b3197955')
    const fakeA = row('ՍЅⅮТ', 'Tether', 9_000_001)
    const fakeB = row('ՍSDT', 'Tether', 9_000_002)
    const fakeC = row('USDT', 'Tether', 9_000_003)
    const top = rankTokenMatches([fakeC, fakeB, fakeA, canonical], 'tether', (t) => t !== canonical)
    expect(top[0]).toBe(canonical)
    expect(top).toEqual([canonical, fakeC, fakeB, fakeA])
  })

  it('the production case: a lookalike with the exact symbol "USDT" ranks below a real token in a lower tier', () => {
    const real = row('USDT.z', 'Tether USD Bridged ZED20', 40)
    const fake = row('USDT', 'Tether USD', 9_000_000)
    expect(rankTokenMatches([fake, real], 'usdt', (t) => t === fake)).toEqual([real, fake])
  })

  it('keeps tier order among the lookalikes themselves, after every real token', () => {
    const realInner = row('ABC', 'My Tether Dollar', 1)
    const fakeContains = row('XYZ', 'Fake Tether Dollar', 9_000_000)
    const fakePrefix = row('TETHERX', 'x', 2)
    const fakeExactName = row('QQQ', 'Tether', 3)
    const fakeExactSymbol = row('TETHER', 'y', 1)
    const fakes = new Set([fakeContains, fakePrefix, fakeExactName, fakeExactSymbol])
    expect(rankTokenMatches([fakeContains, fakePrefix, realInner, fakeExactName, fakeExactSymbol], 'tether', (t) => fakes.has(t)))
      .toEqual([realInner, fakeExactSymbol, fakeExactName, fakePrefix, fakeContains])
  })

  it('breaks a full tie by address, so the order does not flap between renders', () => {
    const hi = row('USDT', 'x', 7, '0x' + 'b'.repeat(40))
    const lo = row('USDT', 'x', 7, '0x' + 'a'.repeat(40))
    expect(rankTokenMatches([hi, lo], 'usdt', none)).toEqual([lo, hi])
    expect(rankTokenMatches([lo, hi], 'usdt', none)).toEqual([lo, hi])
  })
})

describe('rankTokenMatches output', () => {
  it('returns the top 10 by default', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row('USDT', `t${i}`, i))
    const top = rankTokenMatches(rows, 'usdt', none)
    expect(SEARCH_RESULT_LIMIT).toBe(10)
    expect(top).toHaveLength(10)
    expect(top.map((r) => r.holderCount)).toEqual([49, 48, 47, 46, 45, 44, 43, 42, 41, 40])
  })

  it('does not mutate its input', () => {
    const rows = [row('B', 'x', 1), row('A', 'x', 2)]
    const copy = [...rows]
    rankTokenMatches(rows, 'x', none)
    expect(rows).toEqual(copy)
  })

  it('finds the canonical contract first when a dozen lookalikes out-hold it (the reported bug)', () => {
    const canonical = row('USDT', 'Tether USD', 5_000_000, '0x55d398326f99059ff775485246999027b3197955')
    const fakes = Array.from({ length: 12 }, (_, i) => row('USDT', 'Tether USD', 9_000_000 + i))
    const isFake = (t: Row) => t !== canonical
    const top = rankTokenMatches([...fakes, canonical], 'usdt', isFake)
    expect(top[0]).toBe(canonical)
    expect(top).toHaveLength(10)
  })

  it('returns an empty list for no candidates', () => {
    expect(syms(rankTokenMatches([], 'usdt', none))).toEqual([])
  })
})
