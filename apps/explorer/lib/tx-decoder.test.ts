import { describe, it, expect } from 'vitest'
import { attemptedSummary, decodeTx, safeTransferSymbol, type TxTransferInfo } from './tx-decoder'

const base = {
  hash: '0xabc',
  fromAddress: '0x7830c87c02e56aff27fa8ab1241711331fa86f43',
  toAddress: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
  value: '0',
  methodId: '0xca350aa6',
  status: true,
}

const t = (over: Partial<TxTransferInfo>): TxTransferInfo => ({
  tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  fromAddress: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
  toAddress: '0x1111111111111111111111111111111111111111',
  value: '4280000000',
  tokenSymbol: 'USDC',
  tokenDecimals: 6,
  ...over,
})

describe('decodeTx swap detection', () => {
  // Regression: Ethereum tx 0x0efa479c…e4c4 is a Coinbase batch disbursement —
  // one contract paying out 18 different tokens to 18 different recipients.
  // The old rule ("2+ transfers means a swap, describe the first and the last")
  // rendered it as "Swapped 4280.00 USDC for 92801.40 TRAC on a DEX", which is
  // a confident, wholly invented claim. A swap requires the SAME party to both
  // give and receive.
  it('does not call a multi-recipient payout a swap', () => {
    const payout = [
      t({ toAddress: '0x1111111111111111111111111111111111111111' }),
      t({ toAddress: '0x2222222222222222222222222222222222222222' }),
      t({ toAddress: '0x3333333333333333333333333333333333333333', tokenAddress: '0xaea46a60368a7bd060eec7df8cba43b7ef41ad85', tokenSymbol: 'TRAC', tokenDecimals: 18, value: '92801400000000000000000' }),
    ]
    const out = decodeTx(base, payout, 'ETH')
    expect(out.type).not.toBe('swap')
    expect(out.summary).not.toMatch(/Swapped/)
  })

  it('still detects a real swap, where the sender both gives and receives', () => {
    const trader = base.fromAddress
    const swap = [
      t({ fromAddress: trader, toAddress: '0xpair'.padEnd(42, '0'), tokenSymbol: 'USDC', tokenDecimals: 6, value: '1000000000' }),
      t({ fromAddress: '0xpair'.padEnd(42, '0'), toAddress: trader, tokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', tokenSymbol: 'WETH', tokenDecimals: 18, value: '500000000000000000' }),
    ]
    const out = decodeTx({ ...base, methodId: '0x38ed1739' }, swap, 'ETH')
    expect(out.type).toBe('swap')
    expect(out.summary).toContain('USDC')
    expect(out.summary).toContain('WETH')
  })

  it('trusts an explicit swap method name even with no matching transfers', () => {
    expect(decodeTx({ ...base, methodId: '0x7ff36ab5' }, [], 'ETH').type).toBe('swap')
  })

  it('describes a single-recipient token transfer as a transfer', () => {
    const out = decodeTx({ ...base, methodId: '0xa9059cbb' }, [t({})], 'ETH')
    expect(out.type).toBe('transfer')
    expect(out.summary).toMatch(/Transferred/)
  })

  // The single-transfer amount used .toFixed(2): a real zero and a dust transfer (the
  // address-poisoning shape) both read "0.00". formatTokenAmount, as the swap leg uses, tells
  // them apart: a zero is "0", dust that rounds away is "<0.000001".
  describe('single-transfer amount', () => {
    const one = (over: Partial<TxTransferInfo>) =>
      decodeTx({ ...base, methodId: '0xa9059cbb' }, [t(over)], 'ETH').summary

    it('reads a real zero as 0, not 0.00', () => {
      expect(one({ value: '0' })).toBe('Transferred 0 USDC to 0x1111111111…')
    })

    it('does not round a dust amount to 0.00', () => {
      // 1e-7 of an 18-decimal token: below the 6-place display floor.
      expect(one({ value: '100000000000', tokenDecimals: 18 })).toBe('Transferred <0.000001 USDC to 0x1111111111…')
      // 1 base unit of a 6-decimal token is exactly representable.
      expect(one({ value: '1' })).toBe('Transferred 0.000001 USDC to 0x1111111111…')
    })

    it('groups thousands and trims trailing zeros, as the swap leg does', () => {
      expect(one({ value: '4280000000' })).toBe('Transferred 4,280 USDC to 0x1111111111…')
      expect(one({ value: '1500000' })).toBe('Transferred 1.5 USDC to 0x1111111111…')
    })

    it('reads a token with unknown decimals as ?, and a 0-decimal token as a whole number', () => {
      expect(one({ tokenDecimals: undefined })).toBe('Transferred ? USDC to 0x1111111111…')
      expect(one({ value: '42', tokenDecimals: 0 })).toBe('Transferred 42 USDC to 0x1111111111…')
    })

    it('falls back to the token address prefix when the symbol is unknown', () => {
      expect(one({ tokenSymbol: undefined })).toContain(' 0xa0b869 to ')
    })
  })

  it('falls back to a contract call rather than inventing a description', () => {
    const out = decodeTx(base, [], 'ETH')
    expect(out.type).toBe('contract_call')
    expect(out.summary).toMatch(/^Called /)
  })
})

describe('attemptedSummary', () => {
  // decodeTx words every summary as an outcome ("Swapped ..."); a failed tx did not do that.
  it.each([
    ['Sent 0.5000 BNB to PancakeSwap: Router v2', 'Tried to send 0.5000 BNB to PancakeSwap: Router v2'],
    ['Swapped tokens on PancakeSwap', 'Tried to swap tokens on PancakeSwap'],
    ['Approved 0x7830c87c02… to spend tokens', 'Tried to approve 0x7830c87c02… to spend tokens'],
    ['Transferred 12.50 USDT to 0x1111111111…', 'Tried to transfer 12.50 USDT to 0x1111111111…'],
    ['Called 0xa9d1e08c77… — Mint', 'Tried to call 0xa9d1e08c77… — Mint'],
    ['Deployed a new smart contract', 'Tried to deploy a new smart contract'],
  ])('rewrites the outcome verb of %j', (summary, expected) => {
    expect(attemptedSummary(summary)).toBe(expected)
  })

  it('prefixes a summary with no outcome verb', () => {
    expect(attemptedSummary('Contract interaction (no data)')).toBe('Failed: Contract interaction (no data)')
    expect(attemptedSummary('3 token transfers to 2 recipients')).toBe('Failed: 3 token transfers to 2 recipients')
  })

  it('matches the first WORD, not a prefix of it', () => {
    expect(attemptedSummary('Sentinel contract')).toBe('Failed: Sentinel contract')
  })
})

describe('safeTransferSymbol', () => {
  const REAL_USDT_BNB = '0x55d398326f99059ff775485246999027b3197955'
  const SPAM = '0x1234567890abcdef1234567890abcdef12345678'

  it('passes a normal symbol on the real contract through', () => {
    expect(safeTransferSymbol(REAL_USDT_BNB, 'USDT', 'bnb')).toBe('USDT')
    expect(safeTransferSymbol('0x1111111111111111111111111111111111111111', 'CAKE', 'bnb')).toBe('CAKE')
  })

  it('drops a lookalike: a fake USDT is not allowed to headline as USDT', () => {
    expect(safeTransferSymbol(SPAM, 'USDT', 'bnb')).toBeUndefined()
    // Cyrillic TE in place of T: same glyph, different contract.
    expect(safeTransferSymbol(SPAM, 'USD\u0422', 'bnb')).toBeUndefined()
    // BNB / ETH are the chains' native coins: no token contract is them.
    expect(safeTransferSymbol(SPAM, 'BNB', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, 'ETH', 'eth')).toBeUndefined()
  })

  it('the same symbol is judged per chain: real USDT on BNB is a fake on ETH', () => {
    expect(safeTransferSymbol(REAL_USDT_BNB, 'USDT', 'eth')).toBeUndefined()
  })

  it('strips control and bidi characters through sanitizeSymbolOr', () => {
    expect(safeTransferSymbol(SPAM, 'AB\u0007C\u200B', 'bnb')).toBe('ABC')
  })

  it('is undefined when nothing printable survives, or the symbol is missing or a placeholder', () => {
    expect(safeTransferSymbol(SPAM, '\u202E\u200B', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, '', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, null, 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, undefined, 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, '???', 'bnb')).toBeUndefined()
  })
})
