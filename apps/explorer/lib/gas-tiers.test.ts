import { describe, expect, it } from 'vitest'
import { feeCard, GAS_TIER_BLOCKS, GAS_TIER_MIN_TXS, gasTiersFrom, gasTiersNote, gasTiles, type GasTierRow } from './gas-tiers'

const GWEI = 10n ** 9n

// What the tier query returns: block and tx counts, the newest block's base fee, and the 25th/50th/75th
// percentile values as numeric text (percentile_disc picks values that were actually paid: no interpolation).
const bnbRow = (over: Partial<GasTierRow> = {}): GasTierRow =>
  ({ blocks: 20, txs: 1048, baseFee: '0', tiers: ['50000000', '50000001', '74750000'], ...over })
const ethRow = (over: Partial<GasTierRow> = {}): GasTierRow =>
  ({ blocks: 20, txs: 3100, baseFee: String(10n * GWEI), tiers: [String(GWEI), String(2n * GWEI), String(5n * GWEI)], ...over })

describe('gasTiersFrom', () => {
  it('reads slow / standard / fast as the 25th / 50th / 75th percentile', () => {
    expect(gasTiersFrom(bnbRow())).toEqual({ slow: '50000000', standard: '50000001', fast: '74750000', baseFee: null })
  })

  it('keeps the base fee only when it is positive: BNB has none (0 or null), ETH has one', () => {
    expect(gasTiersFrom(bnbRow({ baseFee: '0' }))?.baseFee).toBeNull()
    expect(gasTiersFrom(bnbRow({ baseFee: null }))?.baseFee).toBeNull()
    expect(gasTiersFrom(ethRow())?.baseFee).toBe(String(10n * GWEI))
  })

  it('is null, never a made-up number, when the sample is too thin', () => {
    expect(gasTiersFrom(undefined)).toBeNull()
    expect(gasTiersFrom(bnbRow({ blocks: GAS_TIER_BLOCKS - 1 }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ blocks: 0 }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ txs: 0 }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ txs: 1 }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ tiers: null }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ tiers: ['50000000', null, '74750000'] }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ tiers: ['50000000', '50000001'] }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ tiers: ['50000000', 'NaN', '74750000'] }))).toBeNull()
  })

  // One transaction gives three identical tiers labelled 25th/50th/75th: a percentile needs a sample.
  it('needs at least 20 transactions in the window, so a thin one is "—", not three copies of one price', () => {
    expect(GAS_TIER_MIN_TXS).toBe(20)
    expect(gasTiersFrom(bnbRow({ txs: GAS_TIER_MIN_TXS - 1 }))).toBeNull()
    expect(gasTiersFrom(bnbRow({ txs: GAS_TIER_MIN_TXS }))).not.toBeNull()
  })

  it('carries only strings: a BigInt anywhere in a cached value silently voids the cache write', () => {
    expect(() => JSON.stringify(gasTiersFrom(ethRow()))).not.toThrow()
  })
})

describe('gasTiles', () => {
  it('BNB (no base fee): the tier IS the gas price at that percentile', () => {
    const tiles = gasTiles(gasTiersFrom(bnbRow()))
    expect(tiles.map(t => t.label)).toEqual(['Slow', 'Standard', 'Fast'])
    expect(tiles.map(t => t.gwei)).toEqual(['0.05', '0.05', '0.0747'])
    expect(tiles.map(t => t.basis)).toEqual(['25th percentile gas price', '50th percentile gas price', '75th percentile gas price'])
  })

  it('ETH (EIP-1559): base fee + the tip at that percentile, both shown', () => {
    const tiles = gasTiles(gasTiersFrom(ethRow()))
    expect(tiles.map(t => t.gwei)).toEqual(['11', '12', '15'])
    expect(tiles.map(t => t.basis)).toEqual(['base 10 + tip 1', 'base 10 + tip 2', 'base 10 + tip 5'])
  })

  it('no data reads "—" on every tile, still named by its percentile', () => {
    expect(gasTiles(null)).toEqual([
      { label: 'Slow', gwei: '—', basis: '25th percentile' },
      { label: 'Standard', gwei: '—', basis: '50th percentile' },
      { label: 'Fast', gwei: '—', basis: '75th percentile' },
    ])
  })

  it('has no synthetic buffer anywhere', () => {
    for (const t of [gasTiersFrom(bnbRow()), gasTiersFrom(ethRow()), null]) {
      expect(JSON.stringify(gasTiles(t))).not.toMatch(/10%|30%|\+ ?10|\+ ?30/)
    }
  })
})

describe('gasTiersNote', () => {
  it('always says where the numbers come from: "from the last 20 blocks"', () => {
    for (const t of [gasTiersFrom(bnbRow()), gasTiersFrom(ethRow()), null]) {
      expect(gasTiersNote(t, t?.baseFee != null)).toContain('from the last 20 blocks')
    }
  })

  it('says what a tier is on each kind of chain', () => {
    expect(gasTiersNote(gasTiersFrom(bnbRow()), false)).toMatch(/gas price paid by transactions/)
    expect(gasTiersNote(gasTiersFrom(ethRow()), true)).toMatch(/base fee plus the priority fee/)
  })

  it('a thin sample says there are not enough recent transactions, and still names the sample', () => {
    expect(gasTiersNote(null, false)).toMatch(/^Not enough recent transactions\./)
    expect(gasTiersNote(null, true)).toMatch(/^Not enough recent transactions\..*from the last 20 blocks/)
  })

  it('a failed read says it is not available right now, and still names the sample', () => {
    expect(gasTiersNote(null, false, true)).toMatch(/^Not available right now\./)
    expect(gasTiersNote(null, true, true)).toMatch(/from the last 20 blocks/)
  })

  it('has no synthetic buffer', () => {
    expect(gasTiersNote(gasTiersFrom(bnbRow()), false)).not.toMatch(/10%|30%/)
  })
})

describe('feeCard', () => {
  it('BNB-like (base fee 0): shows the gas price, labelled "Gas Price"', () => {
    expect(feeCard(0n, GWEI / 20n)).toEqual({ label: 'Gas Price', value: GWEI / 20n })
  })

  it('ETH-like (positive base fee): shows the base fee, not the tip-inclusive gas price', () => {
    expect(feeCard(GWEI / 2n, 3n * GWEI / 2n)).toEqual({ label: 'Base Fee', value: GWEI / 2n })
  })

  it('missing base fee (null / undefined, pre-1559 or unreadable block): falls back to "Gas Price"', () => {
    expect(feeCard(null, 5n * GWEI)).toEqual({ label: 'Gas Price', value: 5n * GWEI })
    expect(feeCard(undefined, 5n * GWEI)).toEqual({ label: 'Gas Price', value: 5n * GWEI })
  })
})
