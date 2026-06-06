import { describe, it, expect } from 'vitest'
import { formatGwei, formatUsdPrice, formatCompactUsd, formatPercent } from './format'

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
