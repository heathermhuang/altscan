import { describe, it, expect } from 'vitest'
import { formatGwei } from './format'

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
