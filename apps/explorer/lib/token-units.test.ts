import { describe, it, expect } from 'vitest'
import { legAmount, readDecimals, supplyText } from './token-units'

// A failed decimals() read used to become 18 and a failed totalSupply() 0. ETH USDT and USDC have 6 decimals, so a
// throttled node printed their supply as "0" and every amount a trillion times too small. Unknown stays unknown.
describe('readDecimals', () => {
  it('reads what decimals() answered: a bigint (ethers) or a number (the index)', () => {
    expect(readDecimals(6n)).toBe(6)
    expect(readDecimals(18)).toBe(18)
    expect(readDecimals(0n)).toBe(0)
    expect(readDecimals(255)).toBe(255)
  })

  it('reads a failed call, nothing, and nonsense as unknown, never 18', () => {
    for (const bad of [null, undefined, NaN, Infinity, -1, 256, 1.5, '6', '', {}, 10n ** 30n]) {
      expect(readDecimals(bad), String(bad)).toBeNull()
    }
  })
})

describe('supplyText', () => {
  const USDT_ETH_SUPPLY = (100_000_000_000n * 10n ** 6n).toString() // 100 billion USDT at 6 decimals
  it('scales the supply by the decimals', () => {
    expect(supplyText(USDT_ETH_SUPPLY, 6)).toBe((100_000_000_000n).toLocaleString())
    expect(supplyText((1_000n * 10n ** 18n).toString(), 18)).toBe((1_000n).toLocaleString())
  })

  it('with unknown decimals prints the raw units, labelled: not "0", not scaled by 18', () => {
    const text = supplyText(USDT_ETH_SUPPLY, null)
    expect(text).toBe('100,000,000,000,000,000 raw units')
    expect(text).not.toBe('0')
    // what scaling by a guessed 18 would have printed for this supply
    expect(supplyText(USDT_ETH_SUPPLY, 18)).toBe('0')
  })

  it('reads no supply as "—" whatever the decimals', () => {
    for (const none of [null, undefined, '', '0']) {
      expect(supplyText(none, 6)).toBe('—')
      expect(supplyText(none, null)).toBe('—')
    }
  })
})

describe('legAmount', () => {
  it('scales a leg by its token\'s decimals', () => {
    expect(legAmount('1500000', 6)).toBe('1.5')
    expect(legAmount(2_000_000_000_000_000_000n, 18)).toBe('2')
  })

  it('reads a leg whose token has unknown decimals as "—"', () => {
    expect(legAmount('1500000', null)).toBe('—')
    expect(legAmount('1500000', undefined)).toBe('—')
  })

  it('keeps a known zero-decimals token', () => {
    expect(legAmount('42', 0)).toBe('42')
  })
})
