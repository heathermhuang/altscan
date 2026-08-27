import { describe, it, expect } from 'vitest'
import {
  formatNativeToken,
  formatBNB,
  formatETH,
  formatGwei,
  formatUsdPrice,
  formatCompactUsd,
  formatPercent,
} from './format'

describe('formatNativeToken', () => {
  it('shows exact zero as "0", including for null/undefined wei', () => {
    expect(formatNativeToken(0n)).toBe('0')
    expect(formatNativeToken(null as unknown as bigint)).toBe('0')
    expect(formatNativeToken(undefined as unknown as bigint)).toBe('0')
  })

  it('shows a nonzero amount that rounds to all-zeros as "<0.0001", not "0"', () => {
    // Regression: toFixed(4) collapsed these to "0.0000", indistinguishable
    // from a true zero-value contract call.
    expect(formatNativeToken(1n)).toBe('<0.0001')
    expect(formatNativeToken(30000000000000n)).toBe('<0.0001') // 0.00003 BNB
  })

  it('rounds half-up right at the maxDecimals boundary', () => {
    expect(formatNativeToken(50000000000000n)).toBe('0.0001') // 0.00005 rounds up
    expect(formatNativeToken(100000000000000n)).toBe('0.0001') // 0.0001 exactly
  })

  it('rounds to maxDecimals and trims trailing zeros', () => {
    expect(formatNativeToken(1500000000000000000n)).toBe('1.5')
    expect(formatNativeToken(1234567890000000000n)).toBe('1.2346')
    expect(formatNativeToken(2000000000000000000n)).toBe('2')
    expect(formatNativeToken(12345678123456789012345678n)).toBe('12345678.1235')
  })

  it('never mangles a whole-number-looking result while trimming', () => {
    // Guards the trim regex: formatGwei's `/\.?0+$/` is only safe there because
    // toFixed(decimals>=1) always emits a dot. Applied to a dot-less string it
    // would eat real digits, e.g. "1000" -> "1".
    expect(formatNativeToken(1000000000000000000000n)).toBe('1000')
  })

  it('respects a custom maxDecimals (the markdown route passes 6)', () => {
    expect(formatNativeToken(30000000000000n, 6)).toBe('0.00003')
    expect(formatNativeToken(1n, 6)).toBe('<0.000001')
  })

  it('accepts string wei input', () => {
    expect(formatNativeToken('1500000000000000000')).toBe('1.5')
  })

  it('keeps the formatBNB/formatETH aliases pointing at formatNativeToken', () => {
    expect(formatBNB).toBe(formatNativeToken)
    expect(formatETH).toBe(formatNativeToken)
  })
})

describe('formatGwei', () => {
  it('shows sub-Gwei BNB gas prices instead of collapsing to "0.00"', () => {
    // Regression: toFixed(2) rendered all sub-0.01 Gwei values as "0.00".
    expect(formatGwei(100_000_000n)).toBe('0.1')   // 0.1 Gwei (BNB network minimum)
    expect(formatGwei(120_000_000n)).toBe('0.12')  // 0.12 Gwei
    expect(formatGwei(5_000_000n)).toBe('0.005')   // 0.005 Gwei — was "0.00"
    expect(formatGwei(1_000_000n)).toBe('0.001')   // 0.001 Gwei — was "0.00"
  })

  it('trims trailing zeros but keeps whole numbers intact', () => {
    expect(formatGwei(0n)).toBe('0')
    expect(formatGwei(1_000_000_000n)).toBe('1')     // 1 Gwei
    expect(formatGwei(3_000_000_000n)).toBe('3')     // 3 Gwei
    expect(formatGwei(1_500_000_000n)).toBe('1.5')   // 1.5 Gwei
    expect(formatGwei(100_000_000_000n)).toBe('100') // 100 Gwei — must not become "1"
  })

  it('accepts string input', () => {
    expect(formatGwei('100000000')).toBe('0.1')
  })
})

describe('market formatters', () => {
  it('formatUsdPrice adapts precision', () => {
    expect(formatUsdPrice(1234.5)).toBe('$1,234.50')
    expect(formatUsdPrice(0.1234)).toBe('$0.1234')
    expect(formatUsdPrice(0.00000123)).toBe('$0.00000123')
    expect(formatUsdPrice(NaN)).toBe('—')
  })
  it('formatCompactUsd abbreviates', () => {
    expect(formatCompactUsd(1_250_000_000)).toBe('$1.25B')
    expect(formatCompactUsd(345_600_000)).toBe('$345.6M')
    expect(formatCompactUsd(12_340)).toBe('$12.34K')
  })
  it('formatPercent signs', () => {
    expect(formatPercent(3.2)).toBe('+3.20%')
    expect(formatPercent(-1.5)).toBe('-1.50%')
  })
})
