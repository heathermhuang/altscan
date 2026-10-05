import { describe, expect, it } from 'vitest'
import { gasTierBasis } from './gas-tiers'

const GWEI = 10n ** 9n

describe('gasTierBasis', () => {
  it('says "base fee" while the base fee is what the tiers are priced from', () => {
    expect(gasTierBasis(30n * GWEI, 0n)).toEqual({ slow: 'base fee', standard: 'base fee + 10%', fast: 'base fee + 30%' })
    expect(gasTierBasis(2n * GWEI, GWEI / 10n)).toEqual({ slow: 'base fee', standard: 'base fee + 10%', fast: 'base fee + 30%' })
  })

  it('says "network minimum" once the chain minimum binds (base fee below it, or none read)', () => {
    const floored = { slow: 'network minimum', standard: 'minimum + 10%', fast: 'minimum + 30%' }
    expect(gasTierBasis(GWEI / 20n, GWEI / 10n)).toEqual(floored)
    expect(gasTierBasis(0n, GWEI / 10n)).toEqual(floored)
  })

  it('a base fee exactly at the minimum is the base fee', () => {
    expect(gasTierBasis(GWEI / 10n, GWEI / 10n).slow).toBe('base fee')
  })

  it('a chain with no minimum is never "network minimum", even with no reading', () => {
    expect(gasTierBasis(0n, 0n).slow).toBe('base fee')
  })
})
