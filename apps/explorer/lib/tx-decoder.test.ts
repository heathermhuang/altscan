import { describe, it, expect } from 'vitest'
import { decodeTx, type TxTransferInfo } from './tx-decoder'

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

  it('falls back to a contract call rather than inventing a description', () => {
    const out = decodeTx(base, [], 'ETH')
    expect(out.type).toBe('contract_call')
    expect(out.summary).toMatch(/^Called /)
  })
})
