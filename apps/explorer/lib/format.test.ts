import { describe, it, expect } from 'vitest'
import {
  formatNativeToken,
  formatBNB,
  formatETH,
  formatGwei,
  formatUsdPrice,
  formatCompactUsd,
  formatPercent,
  formatTokenAmount,
  formatUtc,
  sanitizeSymbolOr,
  tokenTextOr,
  tokenLabel,
  UNKNOWN_TOKEN,
  formatHolders,
  formatEstimate,
  hasSupply,
  formatUtcClock,
  ordinal,
} from './format'
import { shortenAddress } from './address-display'

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
    expect(formatGwei(50_000_000n)).toBe('0.05')   // 0.05 Gwei (BNB network minimum)
    expect(formatGwei(100_000_000n)).toBe('0.1')   // 0.1 Gwei
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

describe('formatTokenAmount', () => {
  it('keeps every real digit instead of truncating at 4dp', () => {
    // Etherscan renders this transfer as 232,619.50962301 AMP. The old inline
    // `Number(...)/10**d` with maximumFractionDigits:4 produced 232,619.5096.
    expect(formatTokenAmount('232619509623010000000000', 18)).toBe('232,619.50962301')
  })

  it('matches the USDC amounts from a real receipt', () => {
    expect(formatTokenAmount('4280000000', 6)).toBe('4,280')
    expect(formatTokenAmount('196114295', 6)).toBe('196.114295')
  })

  it('is exact for values beyond Number.MAX_SAFE_INTEGER', () => {
    // 9007199254740993 base units at 0 decimals — 2^53+1, which Number() cannot
    // represent, so the old path rendered 9007199254740992.
    expect(formatTokenAmount('9007199254740993', 0)).toBe('9,007,199,254,740,993')
  })

  it('handles zero and zero-decimal tokens', () => {
    expect(formatTokenAmount('0', 18)).toBe('0')
    expect(formatTokenAmount('5', 0)).toBe('5')
  })

  it('returns the raw value rather than throwing on bad decimals', () => {
    expect(formatTokenAmount('100', -1 as unknown as number)).toBe('100')
  })
})

describe('formatTokenAmount with a display cap', () => {
  it('rounds a huge fractional part to the cap and keeps the integer part grouped', () => {
    // 4,787,630.158322188632852549 — the unrounded value the judge flagged.
    expect(formatTokenAmount('4787630158322188632852549', 18, 6)).toBe('4,787,630.158322')
    // the exact value is still available when no cap is passed
    expect(formatTokenAmount('4787630158322188632852549', 18)).toBe('4,787,630.158322188632852549')
  })

  it('rounds half-up and carries into the integer part', () => {
    expect(formatTokenAmount('1999999999999999999', 18, 6)).toBe('2')
    expect(formatTokenAmount('1500000500000000000', 18, 6)).toBe('1.500001')
    expect(formatTokenAmount('1500000499999999999', 18, 6)).toBe('1.5')
  })

  it('leaves integers and short fractions alone', () => {
    expect(formatTokenAmount('4280000000', 6, 6)).toBe('4,280')
    expect(formatTokenAmount('196114295', 6, 6)).toBe('196.114295')
    expect(formatTokenAmount('67000000000000000000', 18, 6)).toBe('67')
    expect(formatTokenAmount('5', 0, 6)).toBe('5')
    expect(formatTokenAmount('0', 18, 6)).toBe('0')
  })

  it('shows a nonzero amount that rounds to nothing as "<0.000001", never "0"', () => {
    expect(formatTokenAmount('1', 18, 6)).toBe('<0.000001')
    expect(formatTokenAmount('499999999999', 18, 6)).toBe('<0.000001')
    expect(formatTokenAmount('500000000000', 18, 6)).toBe('0.000001')
  })

  it('stays exact above Number.MAX_SAFE_INTEGER', () => {
    expect(formatTokenAmount('9007199254740993123456', 6, 6)).toBe('9,007,199,254,740,993.123456')
    expect(formatTokenAmount(9007199254740993123456789n, 18, 6)).toBe('9,007,199.254741')
  })
})

describe('formatUtc', () => {
  it('formats as YYYY-MM-DD HH:MM:SS UTC from UTC parts', () => {
    expect(formatUtc(new Date('2026-10-04T23:04:41Z'))).toBe('2026-10-04 23:04:41 UTC')
    expect(formatUtc(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02 03:04:05 UTC')
  })

  it('does not depend on the host timezone: a date that differs by zone stays on its UTC day', () => {
    // 23:30 UTC on Oct 4 is already Oct 5 in UTC+1 and later; 00:30 UTC on Oct 5
    // is still Oct 4 in UTC-1 and earlier. Local-getter code gets one of these wrong.
    expect(formatUtc(new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-04 23:30:00 UTC')
    expect(formatUtc(new Date('2026-10-05T00:30:00Z'))).toBe('2026-10-05 00:30:00 UTC')
    expect(formatUtc(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31 23:59:59 UTC')
  })

  it('accepts ISO strings and epoch milliseconds', () => {
    expect(formatUtc('2026-10-04T23:04:41.999Z')).toBe('2026-10-04 23:04:41 UTC')
    expect(formatUtc(Date.UTC(2026, 9, 4, 23, 4, 41))).toBe('2026-10-04 23:04:41 UTC')
  })

  it('renders an invalid date as an em dash instead of "NaN-NaN-NaN"', () => {
    expect(formatUtc(new Date('nope'))).toBe('—')
    expect(formatUtc('')).toBe('—')
  })
})

describe('formatUtcClock', () => {
  it('is the HH:MM of the UTC time, whatever the host timezone', () => {
    expect(formatUtcClock(new Date('2026-10-04T23:04:41Z'))).toBe('23:04 UTC')
    expect(formatUtcClock(new Date('2026-01-02T03:04:05Z'))).toBe('03:04 UTC')
  })

  it('renders an invalid date as an em dash', () => {
    expect(formatUtcClock(new Date('nope'))).toBe('—')
  })
})

describe('sanitizeSymbolOr placeholders', () => {
  it("treats the indexer's '???' / 'Unknown' placeholders as missing", () => {
    expect(sanitizeSymbolOr('???', UNKNOWN_TOKEN)).toBe('Unknown token')
    expect(sanitizeSymbolOr('Unknown', UNKNOWN_TOKEN)).toBe('Unknown token')
    expect(sanitizeSymbolOr('???', '')).toBe('')
  })

  it('still returns real symbols and the fallback for null/empty', () => {
    expect(sanitizeSymbolOr('USDT', UNKNOWN_TOKEN)).toBe('USDT')
    expect(sanitizeSymbolOr(null, UNKNOWN_TOKEN)).toBe('Unknown token')
    expect(sanitizeSymbolOr('', '—')).toBe('—')
  })
})

describe('tokenTextOr / tokenLabel', () => {
  const ADDR = '0x0291bcbffc61d96f288e635d6ce3a31be03dff8e'

  it('tokenTextOr keeps verbatim text (including non-ASCII) and drops placeholders', () => {
    expect(tokenTextOr('躺赢', UNKNOWN_TOKEN)).toBe('躺赢')
    expect(tokenTextOr('???', UNKNOWN_TOKEN)).toBe('Unknown token')
    expect(tokenTextOr(undefined, UNKNOWN_TOKEN)).toBe('Unknown token')
  })

  it('shows a real symbol, else the name', () => {
    expect(tokenLabel('USDT', 'Tether', ADDR)).toBe('USDT')
    expect(tokenLabel(null, 'Tether', ADDR)).toBe('Tether')
  })

  it('reads "Unknown token" for the indexer placeholders, never "???"', () => {
    expect(tokenLabel('???', 'Unknown', ADDR)).toBe('Unknown token')
    expect(tokenLabel(null, null, ADDR)).toBe('Unknown token')
  })

  it('shows the short address when a real symbol was sanitised away, rather than calling it unknown', () => {
    const label = tokenLabel('躺赢', '躺赢人生', ADDR)
    expect(label).toBe(shortenAddress(ADDR))
    expect(label.toLowerCase()).toBe('0x0291bc…dff8e')
  })
})

describe('"—" instead of a number we do not have', () => {
  it('tokenTextOr with "—" reads the indexer placeholders as unknown, never "Unknown" or "???"', () => {
    expect(tokenTextOr('Unknown', '—')).toBe('—')
    expect(tokenTextOr('???', '—')).toBe('—')
    expect(tokenTextOr('Unknown Token', '—')).toBe('—') // the page's live RPC lookup, for a token with no name()
    expect(tokenTextOr(null, '—')).toBe('—')
    expect(tokenTextOr('', '—')).toBe('—')
    expect(tokenTextOr('Tether USD', '—')).toBe('Tether USD')
  })

  it('formatHolders shows "—" for 0 (a lagging count), and a real count unchanged', () => {
    expect(formatHolders(0)).toBe('—')
    expect(formatHolders(null)).toBe('—')
    expect(formatHolders(undefined)).toBe('—')
    expect(formatHolders(NaN)).toBe('—')
    expect(formatHolders(1)).toBe('1')
    expect(formatHolders(1234567)).toBe('1,234,567')
  })

  it('formatEstimate marks a derived figure with ≈, and "—" when there is none', () => {
    expect(formatEstimate(4383)).toBe('≈ 4,383')
    expect(formatEstimate(1)).toBe('≈ 1')
    expect(formatEstimate(0)).toBe('—')
    expect(formatEstimate(null)).toBe('—')
    expect(formatEstimate(Infinity)).toBe('—')
  })

  it('hasSupply is false for null, empty, 0 and unparseable values, true for any positive supply', () => {
    expect(hasSupply('0')).toBe(false)
    expect(hasSupply(null)).toBe(false)
    expect(hasSupply(undefined)).toBe(false)
    expect(hasSupply('')).toBe(false)
    expect(hasSupply('not a number')).toBe(false)
    expect(hasSupply('1')).toBe(true)
    expect(hasSupply('1000000000000000000000000')).toBe(true)
  })
})

describe('ordinal', () => {
  it('uses st/nd/rd/th, with 11–13 as th', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th'])
  })
})
