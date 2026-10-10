import { describe, it, expect } from 'vitest'
import { BSC, ETH } from '@altscan/chain-config'
import {
  holdingFromIndex,
  holdingFromProvider,
  holdingsNote,
  mergeHoldings,
  priceTracked,
  trackedClause,
  trackedTokens,
  usdText,
  type HoldingRow,
} from './holdings'

const WBNB = BSC.whales.wrapped.address
const USDT = BSC.whales.stablecoins[0].address
const USDC = BSC.whales.stablecoins[1].address
const E18 = 10n ** 18n
const tokens = trackedTokens(BSC.whales)

const row = (over: Partial<HoldingRow>): HoldingRow => ({
  tokenAddress: '0x' + '1'.repeat(40), name: null, symbol: 'X', decimals: 18, balance: '1', amount: '1',
  usd: null, basis: null, tracked: false, ...over,
})

describe('trackedTokens', () => {
  it('is the chain config stablecoins plus the wrapped token, by lowercase address', () => {
    expect(tokens.map((t) => [t.symbol, t.kind, t.address])).toEqual([
      ['USDT', 'stablecoin', USDT], ['USDC', 'stablecoin', USDC], ['WBNB', 'wrapped', WBNB],
    ])
    expect(trackedTokens(ETH.whales).map((t) => [t.symbol, t.decimals])).toEqual([['USDT', 6], ['USDC', 6], ['WETH', 18]])
  })
})

describe('priceTracked', () => {
  it('prices stablecoins at $1 by address and the wrapped token at the live native price', () => {
    const rows = priceTracked(tokens, { [USDT]: String(600_000_000n * E18), [USDC]: '0', [WBNB]: String(10n * E18) }, 750)
    expect(rows.map((r) => [r.symbol, r.usd, r.basis, r.tracked])).toEqual([
      ['USDT', 600_000_000, 'stablecoin', true],
      ['WBNB', 7500, 'native', true],
    ])
  })

  it('leaves the wrapped token unpriced when there is no native price, never guesses one', () => {
    const [r] = priceTracked(tokens, { [WBNB]: String(2n * E18) }, null)
    expect(r.usd).toBeNull()
    expect(r.basis).toBeNull()
    expect(r.amount).toBe('2')
  })

  it('drops zero balances and tokens the read did not return', () => {
    expect(priceTracked(tokens, { [USDT]: '0' }, 750)).toEqual([])
    expect(priceTracked(tokens, {}, 750)).toEqual([])
  })

  it('matches by contract address, not by symbol', () => {
    const impostor = { address: '0x' + '9'.repeat(40), symbol: 'USDT', decimals: 18, kind: 'stablecoin' as const }
    // Only the configured tokens are priced: a balance keyed by an impostor's address is not read.
    expect(priceTracked(tokens, { [impostor.address]: String(5n * E18) }, 750)).toEqual([])
  })

  it('keeps fractional balances: 6-decimal USDT on Ethereum', () => {
    const eth = trackedTokens(ETH.whales)
    const [r] = priceTracked(eth, { [ETH.whales.stablecoins[0].address]: '1234567890' }, 3000)
    expect(r.usd).toBeCloseTo(1234.56789, 6)
    expect(r.amount).toBe('1,234.56789')
  })
})

describe('mergeHoldings', () => {
  const live = priceTracked(tokens, { [USDT]: String(500n * E18), [WBNB]: String(2n * E18) }, 750)

  it('puts the live tracked balance in place of the same token from the other source, matched case-insensitively', () => {
    const stale = row({ tokenAddress: USDT.toUpperCase().replace('0X', '0x'), symbol: 'USDT', balance: '7', amount: '7' })
    const merged = mergeHoldings(live, [stale, row({ tokenAddress: '0x' + '2'.repeat(40) })])
    expect(merged.filter((r) => r.symbol === 'USDT')).toHaveLength(1)
    expect(merged.find((r) => r.symbol === 'USDT')!.amount).toBe('500')
  })

  it('sorts by USD value, largest first, with unpriced rows after', () => {
    const cheap = row({ tokenAddress: '0x' + '3'.repeat(40), symbol: 'CHEAP', usd: 3, basis: 'provider' })
    const big = row({ tokenAddress: '0x' + '4'.repeat(40), symbol: 'BIG', usd: 90_000, basis: 'provider' })
    const nothing = row({ tokenAddress: '0x' + '5'.repeat(40), symbol: 'NONE' })
    // USDT is $500, WBNB 2 x $750 = $1,500.
    expect(mergeHoldings(live, [nothing, cheap, big]).map((r) => r.symbol)).toEqual(['BIG', 'WBNB', 'USDT', 'CHEAP', 'NONE'])
  })

  it('keeps the incoming order among unpriced rows', () => {
    const a = row({ tokenAddress: '0x' + 'a'.repeat(40), symbol: 'A' })
    const b = row({ tokenAddress: '0x' + 'b'.repeat(40), symbol: 'B' })
    const c = row({ tokenAddress: '0x' + 'c'.repeat(40), symbol: 'C' })
    expect(mergeHoldings([], [c, a, b]).map((r) => r.symbol)).toEqual(['C', 'A', 'B'])
  })

  it('lists a token once when the other source repeats it', () => {
    const a = row({ tokenAddress: '0x' + 'a'.repeat(40), symbol: 'A', amount: 'first' })
    expect(mergeHoldings([], [a, { ...a, amount: 'second' }]).map((r) => r.amount)).toEqual(['first'])
  })

  it('does not bring back a balance the live read settled at zero', () => {
    const stale = row({ tokenAddress: USDC, symbol: 'USDC', balance: '99', amount: '99', usd: 99, basis: 'provider' })
    // The chain said USDC is 0 (so priceTracked made no row); the index/provider still lists 99.
    expect(mergeHoldings(live, [stale], tokens.map((t) => t.address)).map((r) => r.symbol)).toEqual(['WBNB', 'USDT'])
    // Without a live answer (the read failed) the other source's row stays.
    expect(mergeHoldings([], [stale], []).map((r) => r.symbol)).toEqual(['USDC'])
  })

  it('does not reorder or mutate its inputs', () => {
    const others = [row({ symbol: 'Q' })]
    mergeHoldings(live, others)
    expect(others).toHaveLength(1)
    expect(live.map((r) => r.symbol)).toEqual(['USDT', 'WBNB'])
  })
})

describe('holdingFromProvider / holdingFromIndex', () => {
  const prov = {
    tokenAddress: '0xAbC0000000000000000000000000000000000001', symbol: 'CAKE', name: 'PancakeSwap Token', logo: null,
    decimals: 18, balance: String(3n * E18), balanceFormatted: '3', usdValue: '12.5',
  }

  it("carries the provider's own USD value, lowercases the address, and marks it as the provider's", () => {
    const r = holdingFromProvider(prov)
    expect(r.usd).toBe(12.5)
    expect(r.basis).toBe('provider')
    expect(r.tokenAddress).toBe(prov.tokenAddress.toLowerCase())
    expect(r.tracked).toBe(false)
  })

  it('reads a missing or unusable provider USD value as no price, never as 0', () => {
    expect(holdingFromProvider({ ...prov, usdValue: null }).usd).toBeNull()
    expect(holdingFromProvider({ ...prov, usdValue: 'abc' }).usd).toBeNull()
    expect(holdingFromProvider({ ...prov, usdValue: null }).basis).toBeNull()
  })

  it('formats the amount from the raw balance when the provider gave no formatted one', () => {
    expect(holdingFromProvider({ ...prov, balanceFormatted: null, balance: '1500000000000000000' }).amount).toBe('1.5')
  })

  describe('the amount when the provider also sends balanceFormatted (Moralis always does)', () => {
    // The raw balance and decimals are exact; the formatted string is a float-shaped courtesy. Dust must floor either way.
    const amount = (balance: string, decimals: number, balanceFormatted: string | null) =>
      holdingFromProvider({ ...prov, balance, decimals, balanceFormatted }).amount

    it('floors dust: 1 wei of an 18-decimal token reads "<0.000001", not "0"', () => {
      expect(amount('1', 18, '0.000000000000000001')).toBe('<0.000001')
      expect(amount('400000000000', 18, '0.0000004')).toBe('<0.000001')
    })

    it('reads an ordinary balance as before', () => {
      expect(amount('1500000000000000000', 18, '1.5')).toBe('1.5')
      expect(amount('1234567890100000000000', 18, '1234.5678901')).toBe('1,234.56789')
      expect(amount('0', 18, '0')).toBe('0')
    })

    it('keeps a large balance exact: it is not round-tripped through a float', () => {
      // 2^53 + 1 does not survive parseFloat (it reads ...992); the raw balance does.
      expect(amount('9007199254740993', 0, '9007199254740993')).toBe('9,007,199,254,740,993')
      expect(amount('123456789012345678901234567890', 18, '123456789012.34567890123456789')).toBe('123,456,789,012.345679')
    })

    it('falls back to the formatted amount, floored the same way, only when the raw balance or decimals are unusable', () => {
      expect(amount('', 18, '2.5')).toBe('2.5')
      expect(amount('', 18, '0.000000000000000001')).toBe('<0.000001')
      expect(amount('1000000', Number.NaN, '1')).toBe('1')
    })
  })

  it('an index row has no price', () => {
    const r = holdingFromIndex({ tokenAddress: '0xabc', balance: String(2n * E18), name: 'Foo', symbol: 'FOO', decimals: 18 })
    expect(r.usd).toBeNull()
    expect(r.amount).toBe('2')
  })

  it('an index row for a token whose decimals are unknown shows the raw digits, clipped', () => {
    const r = holdingFromIndex({ tokenAddress: '0xabc', balance: '123456789012345678901234', name: null, symbol: null, decimals: null })
    expect(r.amount).toBe('123456789012345678')
  })
})

describe('trackedClause (the address page lead)', () => {
  const rows = priceTracked(tokens, { [USDT]: String(600_000_000n * E18), [WBNB]: String(10n * E18) }, 750)

  it('states the priced value of the tracked tokens and names them, largest first', () => {
    expect(trackedClause(rows)).toBe('and $600.01M in tracked tokens (USDT, WBNB)')
  })

  it('is null when no tracked token has a balance, so the sentence stays as it was', () => {
    expect(trackedClause([])).toBeNull()
  })

  it('counts only priced rows: an unpriced wrapped balance is neither added nor named', () => {
    const unpriced = priceTracked(tokens, { [USDT]: String(40n * E18), [WBNB]: String(10n * E18) }, null)
    expect(trackedClause(unpriced)).toBe('and $40 in tracked tokens (USDT)')
    expect(trackedClause(priceTracked(tokens, { [WBNB]: String(10n * E18) }, null))).toBeNull()
  })

  it('stays silent about dust', () => {
    expect(trackedClause(priceTracked(tokens, { [USDT]: String(E18 / 100n) }, 750))).toBeNull()
  })
})

describe('usdText', () => {
  it('is a dollar amount for a priced row and "no price" otherwise', () => {
    expect(usdText(row({ usd: 1234.5 }))).toBe('$1,234.50')
    expect(usdText(row({ usd: 0 }))).toBe('$0.00')
    expect(usdText(row({ usd: null }))).toBe('no price')
  })
})

describe('holdingsNote', () => {
  const base = { tracked: tokens, nativeSymbol: 'BNB', nativePriced: true }

  it('names the tracked tokens and how each is priced, then where the rest comes from', () => {
    expect(holdingsNote({ ...base, trackedKnown: true, others: 'index' })).toBe(
      "USDT, USDC and WBNB are read from the chain just now: stablecoins at $1, WBNB at the live BNB price. Other balances come from this explorer's index, a stale snapshot, and are not priced.",
    )
    expect(holdingsNote({ ...base, trackedKnown: true, others: 'moralis' })).toContain('Other balances come from Moralis where it answers, priced only where it has a price.')
    expect(holdingsNote({ ...base, trackedKnown: true, others: 'none' })).not.toContain('Other balances')
  })

  it('calls the index a stale snapshot, never "approximate"', () => {
    expect(holdingsNote({ ...base, trackedKnown: true, others: 'index' })).not.toMatch(/approximate/i)
  })

  it('does not claim a live price for the wrapped token when the price lookup failed', () => {
    const n = holdingsNote({ ...base, nativePriced: false, trackedKnown: true, others: 'none' })
    expect(n).toBe('USDT, USDC and WBNB are read from the chain just now: stablecoins at $1; WBNB has no price right now.')
    expect(n).not.toContain('live BNB price')
  })

  it('says so when the live read failed, instead of implying the tracked tokens were checked', () => {
    const n = holdingsNote({ ...base, trackedKnown: false, others: 'moralis' })
    expect(n).toContain('USDT, USDC and WBNB could not be read from the chain right now.')
    expect(n).not.toContain('just now')
  })
})
