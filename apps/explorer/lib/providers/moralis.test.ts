import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMoralisAdapter } from './moralis'

const CFG = { kind: 'moralis' as const, moralisChain: '0x38' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('createMoralisAdapter — failure envelope', () => {
  it('reports not_configured when MORALIS_API_KEY is absent', async () => {
    vi.stubEnv('MORALIS_API_KEY', '')
    const r = await createMoralisAdapter(CFG).getAddressHistory('0xa4a-nokey')
    expect(r).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('reports disabled when the kill switch is on', async () => {
    vi.stubEnv('MORALIS_DISABLED', 'true')
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const r = await createMoralisAdapter(CFG).getAddressTokenBalances('0xa4a-disabled')
    expect(r).toEqual({ ok: false, reason: 'disabled' })
  })

  it('reports upstream_error on non-OK HTTP and caches the negative (single fetch)', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const a = createMoralisAdapter(CFG)
    const r1 = await a.getAddressHistory('0xa4a-upstream')
    expect(r1).toEqual({ ok: false, reason: 'upstream_error' })
    const r2 = await a.getAddressHistory('0xa4a-upstream')
    expect(r2.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports upstream_error when fetch throws (timeout path)', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    const r = await createMoralisAdapter(CFG).getAddressNfts('0xa4a-throw')
    expect(r).toEqual({ ok: false, reason: 'upstream_error' })
  })
})

describe('createMoralisAdapter — success mapping', () => {
  it('maps a history page to camelCase ProviderTx rows and passes the chain id', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: [{
        hash: '0xh1', block_number: '123', block_timestamp: '2026-07-16T05:25:06Z',
        from_address: '0xf', to_address: '0xt', value: '1000000000000000000',
        gas_price: '5', receipt_gas_used: '21000', category: 'send',
        summary: 'Sent 1 BNB', possible_spam: false,
      }],
      cursor: 'next-page',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await createMoralisAdapter(CFG).getAddressHistory('0xa4a-map')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.txs[0]).toMatchObject({
        hash: '0xh1', blockNumber: '123', fromAddress: '0xf', toAddress: '0xt',
        gasUsed: '21000', possibleSpam: false, erc20Transfers: [],
      })
      expect(r.data.cursor).toBe('next-page')
      expect(r.data.totalTxs).toBe(0) // history endpoint returns no grand total
    }
    expect(String(fetchMock.mock.calls[0][0])).toContain('chain=0x38')
  })

  it('maps owners to TokenHoldersPage and reports upstream_error for a zero-holder result (cache parity with the old null)', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const ok = { total_supply: '5000', result: [{ owner_address: '0xAB', balance: '10', is_contract: true, percentage_relative_to_total_supply: 1.5 }] }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const a = createMoralisAdapter(CFG)
    const r1 = await a.getTokenHolders('0xa4a-token1')
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.data.totalSupply).toBe('5000')
      expect(r1.data.holders[0]).toMatchObject({ address: '0xab', balance: '10', isContract: true, percentage: '1.5' })
    }
    const r2 = await a.getTokenHolders('0xa4a-token2')
    expect(r2).toEqual({ ok: false, reason: 'upstream_error' })
  })
})
