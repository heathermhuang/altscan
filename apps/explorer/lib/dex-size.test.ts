import { describe, expect, it } from 'vitest'
import { dexLegend, dexStripTiles, dexSummary, tradeUsd, type DexSwap } from '@/lib/dex-size'
import { legendLines } from '@/test-support/legend-lines'
import { shortenAddress } from '@/lib/address-display'

const WRAPPED = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
const USDT = '0x55d398326f99059ff775485246999027b3197955'
const USDC6 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const JUNK = '0x1111111111111111111111111111111111111111'
const cfg18 = {
  wrapped: { address: WRAPPED, symbol: 'WBNB', decimals: 18, minValue: '0', indexFloor: '0' },
  stablecoins: [{ address: USDT, symbol: 'USDT', decimals: 18, minValue: '0', indexFloor: '0' }],
}
const cfg6 = {
  wrapped: cfg18.wrapped,
  stablecoins: [{ address: USDC6, symbol: 'USDC', decimals: 6, minValue: '0', indexFloor: '0' }],
}
const E18 = 10n ** 18n
const swap = (o: Partial<DexSwap> & Pick<DexSwap, 'tokenIn' | 'tokenOut' | 'amountIn' | 'amountOut'>): DexSwap => ({
  id: 1, txHash: `0x${'ab'.repeat(32)}`, ...o,
})

describe('tradeUsd', () => {
  it('prices a stablecoin leg at exactly $1 per coin, by decimals', () => {
    expect(tradeUsd(swap({ tokenIn: USDT, amountIn: (91n * E18).toString(), tokenOut: JUNK, amountOut: '5' }), null, cfg18)).toBe(91)
    expect(tradeUsd(swap({ tokenIn: JUNK, amountIn: '5', tokenOut: USDC6, amountOut: '12500000' }), null, cfg6)).toBe(12.5)
  })

  it('prices the wrapped native leg at the native price', () => {
    const t = swap({ tokenIn: JUNK, amountIn: '1', tokenOut: WRAPPED, amountOut: (E18 / 2n).toString() })
    expect(tradeUsd(t, 600, cfg18)).toBe(300)
  })

  it('leaves it unpriced (null) when the only priced leg is native and there is no usable native price', () => {
    const t = swap({ tokenIn: JUNK, amountIn: '1', tokenOut: WRAPPED, amountOut: E18.toString() })
    for (const p of [null, 0, -3, NaN, Infinity]) expect(tradeUsd(t, p, cfg18), String(p)).toBeNull()
  })

  it('prefers the stablecoin leg: $1 per coin is the pegged price, the native one is a market quote', () => {
    const t = swap({ tokenIn: WRAPPED, amountIn: E18.toString(), tokenOut: USDT, amountOut: (590n * E18).toString() })
    expect(tradeUsd(t, 600, cfg18)).toBe(590)
  })

  it('takes the IN leg when both legs are stablecoins', () => {
    const cfg = { ...cfg18, stablecoins: [cfg18.stablecoins[0], { ...cfg18.stablecoins[0], address: JUNK }] }
    const t = swap({ tokenIn: USDT, amountIn: (10n * E18).toString(), tokenOut: JUNK, amountOut: (9n * E18).toString() })
    expect(tradeUsd(t, null, cfg)).toBe(10)
  })

  it('is null when neither leg is a stablecoin or the wrapped native token', () => {
    expect(tradeUsd(swap({ tokenIn: JUNK, amountIn: '5', tokenOut: JUNK, amountOut: '9' }), 600, cfg18)).toBeNull()
  })

  it('matches by contract ADDRESS, in any case, never by symbol (a scam "USDT" is not $1)', () => {
    const upper = swap({ tokenIn: USDT.toUpperCase().replace('0X', '0x'), amountIn: E18.toString(), tokenOut: JUNK, amountOut: '1' })
    expect(tradeUsd(upper, null, cfg18)).toBe(1)
    expect(tradeUsd(swap({ tokenIn: JUNK, amountIn: E18.toString(), tokenOut: JUNK, amountOut: '1' }), null, cfg18)).toBeNull()
  })

  it('a zero amount is a real $0, and a malformed amount is no price at all', () => {
    expect(tradeUsd(swap({ tokenIn: USDT, amountIn: '0', tokenOut: JUNK, amountOut: '1' }), null, cfg18)).toBe(0)
    expect(tradeUsd(swap({ tokenIn: USDT, amountIn: 'x', tokenOut: JUNK, amountOut: '1' }), null, cfg18)).toBeNull()
  })

  // The amount is scaled by the price BEFORE it is divided down: flooring it to hundredths of a coin first
  // priced 0.009 WBNB (at $600) at $0, and 1.999 WETH (at $3,000) at $5,970 instead of $5,997.
  it('does not floor a sub-0.01-coin leg to nothing before pricing it (18-decimal wrapped native)', () => {
    const at = (units: bigint, price: number, wrapped = WRAPPED) =>
      tradeUsd(swap({ tokenIn: JUNK, amountIn: '1', tokenOut: wrapped, amountOut: units.toString() }), price, cfg18)
    expect(at(9n * 10n ** 15n, 600)).toBe(5.4)                  // 0.009 WBNB
    expect(at(99n * 10n ** 14n, 3000)).toBe(29.7)               // 0.0099 WETH
    expect(at(1999n * 10n ** 15n, 3000)).toBe(5997)             // 1.999 WETH
  })

  it('and the same on a 6-decimal chain, for a stablecoin and for a wrapped token with other decimals', () => {
    expect(tradeUsd(swap({ tokenIn: JUNK, amountIn: '1', tokenOut: USDC6, amountOut: '5000' }), null, cfg6)).toBe(0.005)   // 0.005 USDC
    expect(tradeUsd(swap({ tokenIn: USDC6, amountIn: '999999', tokenOut: JUNK, amountOut: '1' }), null, cfg6)).toBe(0.999999)
    const cfg8 = { ...cfg6, wrapped: { ...cfg6.wrapped, decimals: 8 } }   // a WBTC-like wrapped token
    expect(tradeUsd(swap({ tokenIn: JUNK, amountIn: '1', tokenOut: WRAPPED, amountOut: '900000' }), 60000, cfg8)).toBe(540)   // 0.009 coin
  })

  it('a price with cents is applied exactly', () => {
    const t = swap({ tokenIn: JUNK, amountIn: '1', tokenOut: WRAPPED, amountOut: (3n * E18).toString() })
    expect(tradeUsd(t, 612.34, cfg18)).toBeCloseTo(1837.02, 9)
  })

  it('keeps cents on a large amount and does not lose the integer part', () => {
    expect(tradeUsd(swap({ tokenIn: USDT, amountIn: (123456789n * E18 + E18 / 4n).toString(), tokenOut: JUNK, amountOut: '1' }), null, cfg18)).toBe(123456789.25)
  })
})

describe('dexStripTiles', () => {
  const a = swap({ id: 30, tokenIn: USDT, amountIn: (100n * E18).toString(), tokenOut: JUNK, amountOut: '1', txHash: `0x${'aa'.repeat(32)}` })
  const b = swap({ id: 29, tokenIn: JUNK, amountIn: '5', tokenOut: JUNK, amountOut: '9', txHash: `0x${'bb'.repeat(32)}` })
  const c = swap({ id: 28, tokenIn: JUNK, amountIn: '5', tokenOut: WRAPPED, amountOut: (E18 / 10n).toString(), txHash: `0x${'cc'.repeat(32)}` })
  const sym = (addr: string | null) => ({ [USDT]: 'USDT', [WRAPPED]: 'WBNB' }[addr ?? ''] ?? 'Unknown token')
  const tiles = dexStripTiles([a, b, c], 600, sym, cfg18)   // the page's order: newest first

  it('is oldest first (= left to right) with one tile per swap, even two in one transaction', () => {
    expect(tiles.map(t => t.id)).toEqual(['28', '29', '30'])
    const twin = dexStripTiles([a, { ...b, id: 31, txHash: a.txHash }], 600, sym, cfg18)
    expect(twin.map(t => t.id)).toEqual(['31', '30'])
  })

  it('width is the USD size, rounded to whole dollars, at least 1', () => {
    expect(tiles[0].w).toBe(60)    // 0.1 WBNB x $600
    expect(tiles[2].w).toBe(100)
    const dust = dexStripTiles([swap({ tokenIn: USDT, amountIn: (E18 / 4n).toString(), tokenOut: JUNK, amountOut: '1' })], null, sym, cfg18)
    expect(dust[0].w).toBe(1)
  })

  it('an unpriced swap is hatched at a fixed floor width (0 flex-grow), not given an invented size', () => {
    expect(tiles[1]).toMatchObject({ w: 0, f: 0, hatch: true })
    expect(tiles[0].hatch).toBeUndefined()
  })

  it('links to the transaction and reads USD, tokens and block on hover', () => {
    expect(tiles[2].href).toBe(`/tx/0x${'aa'.repeat(32)}`)
    expect(tiles[2].name).toBe('Swap 0xaaaaaa…aaaaa')
    expect(tiles[2].read).toBe('$100 · USDT → Unknown token')
    expect(tiles[1].read).toBe('not priced · Unknown token → Unknown token')
    expect(tiles[0].read).toBe('$60 · Unknown token → WBNB')
  })

  it('clips a long symbol, which anyone can choose, so a readout cannot run to three lines', () => {
    const t = dexStripTiles([swap({ tokenIn: USDT, amountIn: E18.toString(), tokenOut: JUNK, amountOut: '1' })], null, addr => (addr === USDT ? 'USDT' : 'A'.repeat(60)), cfg18)
    expect(t[0].read).toBe(`$1 · USDT → ${'A'.repeat(13)}…`)
  })

  // The legend line shows `name · read`; one that wraps to a third line moves the band (see components/tape).
  it('keeps the readout inside the two-line slot at 320px for the longest realistic swap', () => {
    const big = swap({ tokenIn: USDT, amountIn: (123_456_789n * E18).toString(), tokenOut: JUNK, amountOut: '1' })
    const t = dexStripTiles([big], null, addr => (addr === USDT ? 'S'.repeat(40) : 'T'.repeat(40)), cfg18)[0]
    const said = `${t.name} · ${t.read}`
    expect(legendLines(said), said).toBeLessThanOrEqual(2)
    expect(said.length).toBeGreaterThan(40)
    const none = dexStripTiles([swap({ tokenIn: JUNK, amountIn: '1', tokenOut: JUNK, amountOut: '1' })], null, () => 'S'.repeat(40), cfg18)[0]
    expect(legendLines(`${none.name} · ${none.read}`), none.read).toBeLessThanOrEqual(2)
  })

  // A symbol is typed by whoever deploys the token, and airdrop spam uses it as an advert (lib/link-in-name.ts).
  it('names a token whose symbol reads as a web address or a handle by its short address, in the readout', () => {
    const t = dexStripTiles(
      [swap({ tokenIn: USDT, amountIn: E18.toString(), tokenOut: JUNK, amountOut: '1' })],
      null, addr => (addr === USDT ? 'USDT' : 'Visit claim.xyz'), cfg18,
    )[0]
    expect(t.read).toBe(`$1 · USDT → ${shortenAddress(JUNK)}`)
    expect(`${t.name} ${t.read}`).not.toContain('claim.xyz')
  })

  it('draws nothing for no swaps', () => {
    expect(dexStripTiles([], 600, sym, cfg18)).toEqual([])
  })
})

describe('dex text', () => {
  it('states the pricing in the legend, and when the native price is missing says only stablecoins are priced', () => {
    expect(dexLegend('BNB', true)).toBe('width = USD size (stablecoins $1, BNB at market) · ▨ not priced')
    expect(dexLegend('BNB', false)).toBe('width = USD size (stablecoins at $1 only) · ▨ not priced')
  })

  it('keeps both legends inside the two-line slot at 320px', () => {
    for (const k of [true, false]) {
      const text = dexLegend('ETH', k)
      expect(text.length).toBeGreaterThan(40)
      expect(legendLines(text), text).toBeLessThanOrEqual(2)
    }
  })

  const three = [
    swap({ id: 3, tokenIn: USDT, amountIn: (500n * E18).toString(), tokenOut: JUNK, amountOut: '1' }),
    swap({ id: 2, tokenIn: JUNK, amountIn: '5', tokenOut: JUNK, amountOut: '9' }),
    swap({ id: 1, tokenIn: USDT, amountIn: (20n * E18).toString(), tokenOut: JUNK, amountOut: '1' }),
  ]

  it('summarises for a screen reader: how many are sized, the largest, how many are not priced', () => {
    expect(dexSummary(three, null, 'BNB', cfg18)).toBe(
      '3 swaps, oldest to newest: 2 sized in USD (the largest $500), 1 not priced and drawn hatched at a fixed width. '
      + 'Stablecoins are counted at $1; BNB legs are not priced because the BNB price is unavailable.',
    )
    expect(dexSummary(three, 600, 'BNB', cfg18)).toContain('Stablecoins are counted at $1 and BNB at its market price.')
  })

  it('says so when nothing could be sized, and uses the singular for one swap', () => {
    expect(dexSummary([three[1]], 600, 'BNB', cfg18)).toBe(
      '1 swap: none sized in USD, 1 not priced and drawn hatched at a fixed width. '
      + 'Stablecoins are counted at $1 and BNB at its market price.',
    )
  })
})
