import { describe, it, expect } from 'vitest'
import { formatUnits } from 'ethers'
import { holdingFromProvider } from '@/lib/holdings'
import {
  formatNativeToken,
  formatBNB,
  formatETH,
  formatGwei,
  formatUsdPrice,
  formatCompact,
  formatCompactUsd,
  formatAmountCompact,
  tinyAmount,
  formatPercent,
  formatTokenAmount,
  formatDecimalAmount,
  unitsToDecimal,
  formatUtc,
  sanitizeSymbolOr,
  tokenTextOr,
  tokenLabel,
  tokenText,
  tokenUnit,
  UNKNOWN_TOKEN,
  formatHolders,
  formatEstimate,
  hasSupply,
  formatUtcClock,
  ordinal,
  formatShare,
} from './format'
import { shortenAddress } from './address-display'
import { looksLikeUrlOrHandle as looksLikeRaw } from './link-in-name'

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

// One question for every place a token's symbol or name is printed: does it read as a URL or a handle
// (lib/link-in-name)? It is asked once, here, so the sites cannot drift apart.
describe('tokenText', () => {
  const ADDR = '0x0291bcbffc61d96f288e635d6ce3a31be03dff8e'
  const SHORT = shortenAddress(ADDR)

  it('hands an ordinary token back as the sanitised symbol and the name-cell label, unflagged', () => {
    expect(tokenText('USDT', 'Tether USD', ADDR)).toEqual({ symbol: 'USDT', name: 'USDT', linkLike: false })
    expect(tokenText('USDT.z', 'Tether USD Bridged', ADDR).linkLike).toBe(false)
  })

  it('names a token whose SYMBOL is a URL or handle by its short address in an inline amount, and keeps the text for a name cell', () => {
    const t = tokenText('claim-bnb.xyz', 'Claim', ADDR)
    expect(t.symbol).toBe(SHORT)
    expect(t.name).toBe('claim-bnb.xyz')
    expect(t.linkLike).toBe(true)
    expect(tokenText('@airdrop_bot', null, ADDR).symbol).toBe(SHORT)
  })

  it('flags a URL in the NAME for the badge, but the inline unit is still the symbol (it is the only text an amount prints)', () => {
    const t = tokenText('CLAIM', 'Visit claim-bnb.xyz to claim', ADDR)
    expect(t).toEqual({ symbol: 'CLAIM', name: 'CLAIM', linkLike: true })
  })

  it('keeps a link-like name that is itself the label (no symbol to show)', () => {
    const t = tokenText('???', 'Visit claim-bnb.xyz', ADDR)
    expect(t).toEqual({ symbol: '', name: 'Visit claim-bnb.xyz', linkLike: true })
  })

  it('judges what the page would print as well as the raw text: a Cyrillic letter in ".com" sanitises into a URL', () => {
    const disguised = 'ex\u0430mple.\u0441om'
    expect(looksLikeRaw(disguised)).toBe(false)
    const t = tokenText(disguised, null, ADDR)
    expect(t.linkLike).toBe(true)
    expect(t.symbol).toBe(SHORT)
  })

  it('judges the NAME as the page would print it too: a symbol that reads fine, a name whose Cyrillic letters sanitise into a URL', () => {
    const disguised = 'ex\u0430mple.\u0441om'
    expect(looksLikeRaw(disguised)).toBe(false)
    expect(tokenText('CLAIM', disguised, ADDR)).toEqual({ symbol: 'CLAIM', name: 'CLAIM', linkLike: true })
    expect(tokenText(null, disguised, ADDR).linkLike).toBe(true)
  })

  it('does not flag legitimate names (the sanitised name is judged too, so ordinary and non-ASCII names must stay clean)', () => {
    for (const name of ['Tether USD', 'Wrapped BNB', 'USD Coin', 'PancakeSwap Token', 'Binance-Peg Ethereum Token', '币安人生', 'Ondo U.S. Dollar Token', 'Wrapped Ether (Wormhole)']) {
      expect(tokenText('TKN', name, ADDR).linkLike, name).toBe(false)
    }
  })

  it('judges the raw text too: fullwidth and invisible characters sanitise away, the URL is still an advert', () => {
    const t = tokenText('ｗｗｗ．scam．ｃｏｍ', 'Scam', ADDR)
    expect(t.linkLike).toBe(true)
    expect(t.symbol).toBe(SHORT)
  })

  it('reads the indexer placeholders as nothing to flag and nothing to print', () => {
    expect(tokenText('???', 'Unknown', ADDR)).toEqual({ symbol: '', name: UNKNOWN_TOKEN, linkLike: false })
    expect(tokenText(null, undefined, ADDR)).toEqual({ symbol: '', name: UNKNOWN_TOKEN, linkLike: false })
  })

  it('a real symbol that sanitises away is not unknown and not a link: no unit, the short address as the label', () => {
    expect(tokenText('躺赢', '躺赢人生', ADDR)).toEqual({ symbol: '', name: SHORT, linkLike: false })
  })
})

// The token page, its holders table and /dex print a symbol exactly as they always did; only the URL rule is new.
describe('tokenUnit', () => {
  const ADDR = '0x0291bcbffc61d96f288e635d6ce3a31be03dff8e'

  it('is the symbol as given for anything that is not a URL or handle, even what the sanitiser would change or strip', () => {
    for (const symbol of ['CAKE', 'USDT.z', '???', 'Unknown', '币安', 'BTCΞ', 'BAN人生', 'U\u202eSDT', ' USDT ']) {
      expect(tokenUnit(symbol, ADDR), symbol).toBe(symbol)
    }
  })

  it('is the short token address for a symbol that reads as a URL or handle, as typed or once sanitised', () => {
    for (const symbol of ['claim-bnb.xyz', '@airdrop_bot', 'ｗｗｗ．scam．ｃｏｍ', 'ex\u0430mple.\u0441om']) {
      expect(tokenUnit(symbol, ADDR), symbol).toBe(shortenAddress(ADDR))
    }
  })

  it('agrees with tokenText on which symbols are links, so the sites cannot drift', () => {
    for (const symbol of ['CAKE', 'USDT.z', 'claim-bnb.xyz', '@airdrop_bot', 'ex\u0430mple.\u0441om', '币安']) {
      expect(tokenUnit(symbol, ADDR) !== symbol).toBe(tokenText(symbol, null, ADDR).linkLike)
    }
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

describe('formatShare', () => {
  it('prints one decimal, but never 0.0 for a share that is not zero', () => {
    expect(formatShare(0.047)).toBe('<0.1')   // a 21k-gas tx in a 30M-gas block
    expect(formatShare(0.0999)).toBe('<0.1')  // the last value below the 0.1 boundary
    expect(formatShare(0)).toBe('0.0')
    expect(formatShare(0.1)).toBe('0.1')
    expect(formatShare(58.708)).toBe('58.7')
  })
})

describe('formatCompact', () => {
  it('reads a billions-scale figure as billions, never as thousands of millions', () => {
    // The /dex bug: 8,265,400,000 rendered "8265.40M" because the ladder stopped at M.
    expect(formatCompact(8_265_400_000)).toBe('8.27B')
    expect(formatCompact(1_000_000_000)).toBe('1B')
  })

  it('uses K / M / B / T with at most two decimals and no trailing zeros', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(1_000)).toBe('1K')
    expect(formatCompact(12_340)).toBe('12.34K')
    expect(formatCompact(345_600_000)).toBe('345.6M')
    expect(formatCompact(1_250_000_000)).toBe('1.25B')
    expect(formatCompact(2_500_000_000_000)).toBe('2.5T')
  })

  it('carries into the next unit instead of printing 1000.00 of the smaller one', () => {
    expect(formatCompact(999_994)).toBe('999.99K')
    expect(formatCompact(999_995)).toBe('1M')
    expect(formatCompact(999_995_000)).toBe('1B')
    expect(formatCompact(999_995_000_000)).toBe('1T')
  })

  it('stops at 999T: a figure beyond it says "999T+", never "1000000.00T"', () => {
    // The live /token supply bug: a 1e18-token supply printed "1000000.00T".
    expect(formatCompact(1e18)).toBe('999T+')
    expect(formatCompact(1e15)).toBe('999T+')
    // 999.995T would round to "1000T"; the cap applies to the rounded reading.
    expect(formatCompact(999_995_000_000_000)).toBe('999T+')
    expect(formatCompact(999_994_000_000_000)).toBe('999.99T')
  })

  it('keeps the sign, and the cap applies to the magnitude', () => {
    expect(formatCompact(-5_000_000)).toBe('-5M')
    expect(formatCompact(-1e18)).toBe('-999T+')
  })

  it('never shows a non-zero value as 0, on either side of it', () => {
    expect(formatCompact(0.004)).toBe('<0.01')
    expect(formatCompact(0.01)).toBe('0.01')
    // A negative that rounds to nothing is "above -0.01", never "-0".
    expect(formatCompact(-0.004)).toBe('>-0.01')
    expect(formatCompact(-0.01)).toBe('-0.01')
    expect(formatCompact(0)).toBe('0')
    expect(formatCompactUsd(-0.004)).toBe('>-$0.01')
  })

  it('reads "—" for a number we do not have', () => {
    expect(formatCompact(NaN)).toBe('—')
    expect(formatCompact(Infinity)).toBe('—')
    expect(formatCompact(undefined)).toBe('—')
    expect(formatCompact(null)).toBe('—')
  })

  it('formatCompactUsd is the same ladder with a dollar sign in front of the digits', () => {
    expect(formatCompactUsd(8_265_400_000)).toBe('$8.27B')
    expect(formatCompactUsd(-5_000_000)).toBe('-$5M')
    expect(formatCompactUsd(1e18)).toBe('$999T+')
    expect(formatCompactUsd(0.004)).toBe('<$0.01')
    expect(formatCompactUsd(NaN)).toBe('—')
    expect(formatCompactUsd(undefined)).toBe('—')
  })
})

describe('tinyAmount', () => {
  it('is "<0." then zeros then a 1, one place for every precision a table uses', () => {
    expect(tinyAmount(4)).toBe('<0.0001')
    expect(tinyAmount(6)).toBe('<0.000001')
    expect(tinyAmount(1)).toBe('<0.1')
  })

  it('is what every fixed-decimal amount formatter returns for a non-zero amount that rounds to zero', () => {
    expect(formatNativeToken(1n)).toBe(tinyAmount(4))
    expect(formatNativeToken(1n, 6)).toBe(tinyAmount(6))
    expect(formatTokenAmount('1', 18, 4)).toBe(tinyAmount(4))
  })
})

describe('formatAmountCompact', () => {
  it('shows a non-zero amount that rounds to 0.0000 as "<0.0001", never "0.0000"', () => {
    // The /dex bug: `amt.toFixed(4)` printed "0.0000 WBNB" for a dust swap.
    expect(formatAmountCompact('1', 18)).toBe('<0.0001')
    expect(formatAmountCompact('49999999999999', 18)).toBe('<0.0001')
    expect(formatAmountCompact('50000000000000', 18)).toBe('0.0001')
  })

  it('leaves zero as "0"', () => {
    expect(formatAmountCompact('0', 18)).toBe('0')
    expect(formatAmountCompact(0n, 6)).toBe('0')
  })

  it('is exact to four places below 1,000, trimming trailing zeros', () => {
    expect(formatAmountCompact('12345600000000000000', 18)).toBe('12.3456')
    expect(formatAmountCompact('5000000000000000000', 18)).toBe('5')
    expect(formatAmountCompact('999999999999999999999', 18)).toBe('1,000') // rounds up at four places, still grouped
    expect(formatAmountCompact('999500000', 6)).toBe('999.5')
  })

  it('goes compact from 1,000 up, through the one compact ladder', () => {
    expect(formatAmountCompact('1000000000', 6)).toBe('1K')
    expect(formatAmountCompact('8265400000000000000000000000', 18)).toBe('8.27B')
    expect(formatAmountCompact('1000000000000000000000000', 18)).toBe('1M')
    expect(formatAmountCompact('1000000000000000000000000000000000000', 18)).toBe('999T+')
  })

  it('reads a bad amount rather than throwing', () => {
    expect(formatAmountCompact('not a number', 18)).toBe('0')
  })
})

// formatTokenAmount used ethers' formatUnits, which put ethers' units code into every client chunk that merely
// imports lib/format once the address Holdings tab (a client component) started formatting amounts: +5 kB First
// Load JS on /address and +4 kB on /token/[a]. unitsToDecimal is the same conversion in plain BigInt.
describe('unitsToDecimal', () => {
  const units = [0n, 1n, 9n, 10n, 999999n, 1_000_000n, 1_500_000_000_000_000_000n, 2n * 10n ** 18n, 123456789012345678901234567890n, 10n ** 40n, -1n, -1_500_000n, -(10n ** 18n)]
  const places = [0, 1, 2, 4, 6, 8, 18, 24]

  it('equals ethers formatUnits for whole, fractional, tiny, huge and negative values at every precision', () => {
    for (const u of units) for (const p of places) expect(unitsToDecimal(u, p), `${u} @ ${p}`).toBe(formatUnits(u, p))
  })

  it('formatTokenAmount keeps its output', () => {
    expect(formatTokenAmount('1500000000000000000', 18)).toBe('1.5')
    expect(formatTokenAmount('4787630158322188632852549', 18, 6)).toBe('4,787,630.158322')
    expect(formatTokenAmount('1', 18, 6)).toBe('<0.000001')
  })
})

// The transfers tab (a client component) used parseFloat(valueFormatted).toLocaleString(.., { maximumFractionDigits: 6 }),
// which prints any amount under 0.0000005 as "0" -- the same as a zero-value transfer. It now reads the amount through
// formatTokenAmount at six places, the helper and floor the Holdings tab on the same page uses.
describe('formatDecimalAmount', () => {
  const inline = (v: string) => parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 6 })

  it.each(['0.0000004', '0.00000049', '0.00000001', '0.000000000000000001'])('reads the dust amount %s as "<0.000001", not "0"', (v) => {
    expect(formatDecimalAmount(v)).toBe('<0.000001')
  })

  it('keeps zero as "0", whatever its spelling', () => {
    for (const v of ['0', '0.0', '0.000000000000000000']) expect(formatDecimalAmount(v)).toBe('0')
  })

  it('gives the same text as the Holdings tab for the same amount', () => {
    // The Holdings tab's real provider path: holdingFromProvider with the balanceFormatted Moralis always sends.
    const holdings = (decimal: string, raw: string, decimals: number) =>
      holdingFromProvider({ tokenAddress: '0x' + '1'.repeat(40), symbol: 'X', name: 'X', logo: null, decimals, balance: raw, balanceFormatted: decimal, usdValue: null }).amount
    const cases: Array<[string, string, number]> = [
      ['0.000000000000000001', '1', 18],
      ['0.0000004', '400000000000', 18],
      ['0.0000005', '500000000000', 18],
      ['0.000001', '1000000000000', 18],
      ['0.00001', '10000000000000', 18],
      ['0.000123456789', '123456789000000', 18],
      ['1234567.1234567', '1234567123456700000000000', 18],
      ['1234.5', '1234500000', 6],
      ['25', '25', 0],
      ['0', '0', 18],
      ['123456789012345680000', '123456789012345680000', 0],
    ]
    for (const [decimal, raw, decimals] of cases) expect(formatDecimalAmount(decimal), decimal).toBe(holdings(decimal, raw, decimals))
    expect(formatDecimalAmount('0.000000000000000001')).toBe('<0.000001')
  })

  it('prints every amount from 0.000001 up exactly as the inline expression did', () => {
    for (const v of ['0.000001', '0.00001', '0.0001', '0.000123456', '0.5', '1', '1234.5', '999999.9999999', '1234567.1234567', '123456789012345680000']) {
      expect(formatDecimalAmount(v), v).toBe(inline(v))
    }
    expect(formatDecimalAmount('1234567.1234567')).toBe('1,234,567.123457')
  })

  it.each([['1e-7', '<0.000001'], ['1.5e-7', '<0.000001'], ['4.9e-7', '<0.000001'], ['1E-18', '<0.000001'], ['1e-400', '<0.000001']])(
    'floors exponent form, where JS prints small numbers: %s reads %s, not the text itself', (v, out) => {
      expect(formatDecimalAmount(v)).toBe(out)
    })

  it('reads exponent form exactly: the same text as the plain decimal for the same amount', () => {
    for (const [exp, plain] of [['5e-7', '0.0000005'], ['1e-6', '0.000001'], ['1.5e-6', '0.0000015'], ['2.5e-3', '0.0025'], ['1.5e3', '1500'], ['2E+2', '200'], ['12.5e0', '12.5']]) {
      expect(formatDecimalAmount(exp), exp).toBe(formatDecimalAmount(plain))
    }
    expect(formatDecimalAmount('1.5e3')).toBe('1,500')
    expect(formatDecimalAmount('5e-7')).toBe('0.000001') // rounds half-up to the floor, like formatTokenAmount
  })

  it('returns text it cannot read as a non-negative number unchanged, rather than a made-up one', () => {
    for (const v of ['', 'n/a', '-1.5', '1e', '1e999999', '1e-999999']) expect(formatDecimalAmount(v)).toBe(v)
  })
})
