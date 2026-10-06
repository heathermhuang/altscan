import { describe, expect, it } from 'vitest'
import { feeCard, gasTierBasis } from './gas-tiers'

const GWEI = 10n ** 9n

describe('gasTierBasis', () => {
  it('says "gas price" while the RPC gas price is what the tiers are priced from', () => {
    expect(gasTierBasis(30n * GWEI, 0n)).toEqual({ slow: 'gas price', standard: 'gas price + 10%', fast: 'gas price + 30%' })
    expect(gasTierBasis(2n * GWEI, GWEI / 10n)).toEqual({ slow: 'gas price', standard: 'gas price + 10%', fast: 'gas price + 30%' })
  })

  it('never calls the tier price the "base fee" (eth_gasPrice includes the tip)', () => {
    expect(JSON.stringify(gasTierBasis(30n * GWEI, 0n))).not.toMatch(/base fee/i)
    expect(JSON.stringify(gasTierBasis(0n, GWEI / 10n))).not.toMatch(/base fee/i)
  })

  it('says "network minimum" once the chain minimum binds (reading below it, or none read)', () => {
    const floored = { slow: 'network minimum', standard: 'minimum + 10%', fast: 'minimum + 30%' }
    expect(gasTierBasis(GWEI / 20n, GWEI / 10n)).toEqual(floored)
    expect(gasTierBasis(0n, GWEI / 10n)).toEqual(floored)
  })

  it('a gas price exactly at the minimum is the gas price', () => {
    expect(gasTierBasis(GWEI / 10n, GWEI / 10n).slow).toBe('gas price')
  })

  it('a chain with no minimum is never "network minimum", even with no reading', () => {
    expect(gasTierBasis(0n, 0n).slow).toBe('gas price')
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
