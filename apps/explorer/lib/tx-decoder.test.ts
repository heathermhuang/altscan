import { describe, it, expect } from 'vitest'
import { approvalStandard, attemptedSummary, decodeTx, pendingSummary, safeTransferSymbol, type TxTransferInfo } from './tx-decoder'

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

describe('pendingSummary', () => {
  // decodeTx words every summary as an outcome ("Sent 0.5 BNB"); a tx with no receipt has not done
  // anything yet, so each outcome verb becomes its present participle.
  it.each([
    ['Sent 0.5000 BNB to PancakeSwap: Router v2', 'Sending 0.5000 BNB to PancakeSwap: Router v2'],
    ['Swapped 1 USDT for 2 CAKE on a DEX', 'Swapping 1 USDT for 2 CAKE on a DEX'],
    ['Swapped tokens on PancakeSwap', 'Swapping tokens on PancakeSwap'],
    ['Approved 0x7830c87c02… to spend tokens', 'Approving 0x7830c87c02… to spend tokens'],
    ['Transferred 12.5 USDT to 0x1111111111…', 'Transferring 12.5 USDT to 0x1111111111…'],
    ['Called 0xa9d1e08c77… — Mint', 'Calling 0xa9d1e08c77… — Mint'],
    ['Deployed a new smart contract', 'Deploying a new smart contract'],
  ])('rewrites the outcome verb of %j', (summary, expected) => {
    expect(pendingSummary(summary)).toBe(expected)
  })

  it('prefixes a summary with no outcome verb', () => {
    expect(pendingSummary('Contract interaction (no data)')).toBe('Pending: Contract interaction (no data)')
    expect(pendingSummary('3 token transfers to 2 recipients')).toBe('Pending: 3 token transfers to 2 recipients')
  })

  it('matches the first WORD, not a prefix of it, and a bare verb', () => {
    expect(pendingSummary('Sentinel contract')).toBe('Pending: Sentinel contract')
    expect(pendingSummary('Sent')).toBe('Sending')
  })

  it('agrees with attemptedSummary on which summaries open with an outcome verb', () => {
    for (const s of ['Sent 1 BNB', 'Swapped tokens', 'Approved x', 'Transferred 1 A', 'Called x', 'Deployed a new smart contract']) {
      expect(attemptedSummary(s).startsWith('Tried to')).toBe(true)
      expect(pendingSummary(s).startsWith('Pending: ')).toBe(false)
    }
    for (const s of ['3 token transfers', 'Contract interaction (no data)']) {
      expect(attemptedSummary(s).startsWith('Failed: ')).toBe(true)
      expect(pendingSummary(s).startsWith('Pending: ')).toBe(true)
    }
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

  // Check what the page will SHOW, not what was stored: foldConfusables keeps a character the glyph table
  // has no entry for (U+20AC) that sanitizeSymbol strips, so "US<euro>DT" does not fold to USDT, yet displays as USDT.
  it('judges the sanitised symbol too: a stray character cannot hide a lookalike', () => {
    expect(safeTransferSymbol(SPAM, 'US\u20ACDT', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, 'US\u0007DT', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, 'U\u0001S\u001FDT', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, 'BN\u0007B', 'bnb')).toBeUndefined()   // native coin
  })

  it('a zero-width character inside a lookalike does not hide it either', () => {
    expect(safeTransferSymbol(SPAM, 'USD\u200BT', 'bnb')).toBeUndefined()   // zero-width space
    expect(safeTransferSymbol(SPAM, 'US\u200DDT', 'bnb')).toBeUndefined()   // zero-width joiner
  })

  it('the real contract keeps its symbol, even with a stripped character in it', () => {
    expect(safeTransferSymbol(REAL_USDT_BNB, 'USDT', 'bnb')).toBe('USDT')
    expect(safeTransferSymbol(REAL_USDT_BNB, 'US\u0007DT', 'bnb')).toBe('USDT')
  })

  it('a benign symbol with a stripped character that collides with nothing shows its sanitised form', () => {
    expect(safeTransferSymbol(SPAM, 'CA\u0007KE', 'bnb')).toBe('CAKE')
    expect(safeTransferSymbol(SPAM, 'C\u200BAKE', 'bnb')).toBe('CAKE')
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
  // A symbol that is an advert ("claim-bnb.xyz", "@airdrop_bot") must not headline the page in its largest
  // type: the headline names the token by its short address instead (decodeTx's fallback).
  it('drops a symbol that reads as a URL or a handle, on any contract, the real one included', () => {
    for (const bad of ['claim-bnb.xyz', 'https://claim.io', 'www.airdrop.com', 't.me/scam', '@airdrop_bot', 'Visit uniswap.org']) {
      expect(safeTransferSymbol(SPAM, bad, 'bnb')).toBeUndefined()
    }
    expect(safeTransferSymbol(REAL_USDT_BNB, 'usdt.com', 'bnb')).toBeUndefined()
  })

  it('judges the sanitised and the raw symbol: a stray character or fullwidth letters cannot hide a URL', () => {
    expect(safeTransferSymbol(SPAM, 'claim\u0007-bnb.xyz', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, 'claim-bnb\u200B.xyz', 'bnb')).toBeUndefined()
    expect(safeTransferSymbol(SPAM, 'ｗｗｗ．ｃｌａｉｍ．ｃｏｍ', 'bnb')).toBeUndefined()
  })

  it('keeps tickers with dots and numbers', () => {
    expect(safeTransferSymbol(SPAM, 'USDT.z', 'bnb')).toBe('USDT.z')
    expect(safeTransferSymbol(SPAM, 'BTC.b', 'bnb')).toBe('BTC.b')
    expect(safeTransferSymbol(SPAM, 'UBANK2.0', 'bnb')).toBe('UBANK2.0')
  })
})

describe('headline of a transfer of a token whose symbol is a URL', () => {
  const SPAM_TOKEN = '0x1234567890abcdef1234567890abcdef12345678'
  const transfer = (symbol: string | undefined): TxTransferInfo =>
    t({ tokenAddress: SPAM_TOKEN, fromAddress: base.toAddress, tokenSymbol: symbol, tokenDecimals: 18, value: '5000000000000000000' })

  it('names the token by its short address, not by the advert', () => {
    const tx = { ...base, methodId: '0xa9059cbb' }
    const safe = safeTransferSymbol(SPAM_TOKEN, 'claim-bnb.xyz', 'bnb')
    const { summary } = decodeTx(tx, [transfer(safe)])
    expect(summary).toMatch(/^Transferred 5 0x123456 to /)
    expect(summary).not.toMatch(/claim|xyz/)
  })

  it('a swap leg and a "N transfers of X" line do the same', () => {
    const safe = safeTransferSymbol(SPAM_TOKEN, 'claim-bnb.xyz', 'bnb')
    const swap = decodeTx({ ...base, methodId: '0x38ed1739' }, [
      t({ fromAddress: base.fromAddress, tokenSymbol: 'USDC' }),
      transfer(safe), // the received leg
    ].map((x, i) => (i === 1 ? { ...x, fromAddress: '0x2222222222222222222222222222222222222222', toAddress: base.fromAddress } : x)))
    expect(swap.summary).toMatch(/ for 5 0x123456 on /)
    const many = decodeTx({ ...base, methodId: '0xa9059cbb' }, [transfer(safe), { ...transfer(safe), toAddress: '0x3333333333333333333333333333333333333333' }])
    expect(many.summary).toBe('2 token transfers to 2 recipients')
  })
})

// approve(spender, amount) is sent TO the token contract, so tx.toAddress is the token and the
// grantee is in the calldata. The headline used to name the token contract as the one "approved to
// spend tokens": it pointed the reader at the wrong address on the very action where the right one
// matters most.
describe('decodeTx approvals', () => {
  const TOKEN = '0x55d398326f99059ff775485246999027b3197955'
  const SPENDER = '0x1111111111111111111111111111111111111111'
  const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e' // labelled "PancakeSwap: Router v2" on BNB
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
  const approveInput = (spender: string, amount: bigint) =>
    '0x095ea7b3' + word(spender) + word(amount.toString(16))
  // Amount readings need the Approval event's proof of ERC-20; the cases below have it unless they say otherwise.
  const approve = (input: string | null | undefined, over: { toTokenSymbol?: string; approvalStandard?: 'fungible' | 'nft' | null } = {}) =>
    decodeTx({ ...base, toAddress: TOKEN, methodId: '0x095ea7b3', input, approvalStandard: 'fungible', ...over }, [], 'BNB')

  it('names the spender from the calldata, not the token contract the tx was sent to', () => {
    const out = approve(approveInput(SPENDER, 1000n))
    expect(out.type).toBe('approval')
    expect(out.summary).toContain(SPENDER.slice(0, 12))
    expect(out.summary).not.toContain(TOKEN.slice(0, 12))
    expect(out.summary).not.toContain('USDT (BSC)') // the token contract's own address label
  })

  it('uses the address label of the spender when it has one', () => {
    expect(approve(approveInput(ROUTER, 1000n)).summary).toBe('Approved PancakeSwap: Router v2 to spend tokens')
  })

  it('names the token by its symbol when the page resolved one', () => {
    expect(approve(approveInput(SPENDER, 1000n), { toTokenSymbol: 'USDT' }).summary)
      .toBe(`Approved ${SPENDER.slice(0, 12)}… to spend USDT`)
  })

  it('says unlimited from 2^255 up, and only then', () => {
    const max = 2n ** 256n - 1n
    expect(approve(approveInput(SPENDER, max), { toTokenSymbol: 'USDT' }).summary).toContain('to spend unlimited USDT')
    expect(approve(approveInput(SPENDER, 2n ** 255n)).summary).toContain('to spend unlimited tokens')
    expect(approve(approveInput(SPENDER, 2n ** 255n - 1n)).summary).not.toContain('unlimited')
  })

  it('reads an approval of zero as a revocation, not a grant', () => {
    const out = approve(approveInput(SPENDER, 0n), { toTokenSymbol: 'USDT' })
    expect(out.type).toBe('approval')
    expect(out.summary).toBe(`Revoked ${SPENDER.slice(0, 12)}…'s approval to spend USDT`)
    expect(attemptedSummary(out.summary)).toMatch(/^Tried to revoke /)
    expect(pendingSummary(out.summary)).toMatch(/^Revoking /)
  })

  it.each([
    ['no calldata at all', undefined],
    ['null calldata', null],
    ['calldata pruned to 0x', '0x'],
    ['calldata cut short', '0x095ea7b3' + word(SPENDER)],
    ['non-hex calldata', '0x095ea7b3' + 'zz'.repeat(64)],
    ['calldata for another method', '0xa9059cbb' + word(SPENDER) + word('1')],
  ])('does not name the token contract as the spender when it has %s', (_what, input) => {
    const out = approve(input)
    expect(out.type).toBe('approval')
    expect(out.summary).toBe('Approved a token allowance')
    expect(out.summary).not.toContain(TOKEN.slice(0, 12))
    expect(out.summary).not.toContain('USDT (BSC)')
  })

  it('reads a long (truncated-at-500-chars) approve the same as a short one', () => {
    const long = approveInput(SPENDER, 1000n) + 'ab'.repeat(200)
    expect(approve(long).summary).toBe(`Approved ${SPENDER.slice(0, 12)}… to spend tokens`)
  })
})

// ERC-721 shares approve(address,uint256), but its second argument is a token id: approve(spender, 0)
// grants token #0, it revokes nothing. Only the Approval event tells the two apart.
describe('decodeTx approvals of an unproven standard', () => {
  const TOKEN = '0x55d398326f99059ff775485246999027b3197955'
  const SPENDER = '0x1111111111111111111111111111111111111111'
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
  const input = (amount: bigint) => '0x095ea7b3' + word(SPENDER) + word(amount.toString(16))
  const approve = (amount: bigint, approvalStandard: 'nft' | null) =>
    decodeTx({ ...base, toAddress: TOKEN, methodId: '0x095ea7b3', input: input(amount), toTokenSymbol: 'PUNK', approvalStandard }, [], 'BNB').summary

  it.each(['nft', null] as const)('does not read a zero second argument as a revocation (standard %s)', (std) => {
    expect(approve(0n, std)).toBe(`Approved ${SPENDER.slice(0, 12)}… on PUNK`)
  })

  it.each(['nft', null] as const)('does not read a huge second argument as unlimited (standard %s)', (std) => {
    expect(approve(2n ** 256n - 1n, std)).not.toContain('unlimited')
  })
})

describe('approvalStandard', () => {
  const TOKEN = '0x' + '55'.repeat(20)
  const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
  const t = (n: number) => '0x' + String(n).repeat(64)

  it('is fungible for an ERC-20 Approval (two indexed arguments) at the token', () => {
    expect(approvalStandard([{ address: TOKEN, topic0: APPROVAL, topic3: null }], TOKEN)).toBe('fungible')
  })

  it('is nft for an ERC-721 Approval (the token id indexed too)', () => {
    expect(approvalStandard([{ address: TOKEN.toUpperCase().replace('0X', '0x'), topic0: APPROVAL, topic3: t(0) }], TOKEN)).toBe('nft')
  })

  it('is unknown without an Approval event from the token itself', () => {
    expect(approvalStandard([], TOKEN)).toBeNull()
    expect(approvalStandard([{ address: '0x' + '66'.repeat(20), topic0: APPROVAL, topic3: null }], TOKEN)).toBeNull()
    expect(approvalStandard([{ address: TOKEN, topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic3: null }], TOKEN)).toBeNull()
    expect(approvalStandard([{ address: TOKEN, topic0: APPROVAL, topic3: null }], null)).toBeNull()
  })
})
