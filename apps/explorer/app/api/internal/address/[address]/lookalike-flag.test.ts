import { afterEach, describe, expect, it, vi } from 'vitest'

// The Transfers and Holdings tabs are client components and badge a token that passes for a well-known one. They cannot
// judge that themselves (lib/lookalike stays out of the browser, client-chain-config.test.ts), so these two routes put the
// verdict on every row they serve: `lookalike` is {symbol, canonical} for a flagged token and null for the rest.
const ADDR = '0x' + '1'.repeat(40)
const SPAM = '0x' + 'a'.repeat(40)
const BNB_USDT = '0x55d398326f99059fF775485246999027B3197955'
const USDT_FLAG = { symbol: 'USDT', canonical: BNB_USDT }
const params = Promise.resolve({ address: ADDR })

const transfer = (tokenAddress: string, tokenSymbol: string) => ({
  txHash: '0x' + 'b'.repeat(64), logIndex: '1', blockNumber: '100', blockTimestamp: '2026-10-10T00:00:00.000Z',
  fromAddress: ADDR, toAddress: '0x' + '2'.repeat(40), tokenAddress, tokenName: 'n', tokenSymbol, tokenDecimals: '18',
  value: '1', valueFormatted: '1', direction: 'in',
})
const rows = () => [transfer(SPAM, 'USDT'), transfer(BNB_USDT, 'USDT'), transfer(SPAM, 'CAKE')]
const verdicts = (body: { transfers: { lookalike: unknown }[] }) => body.transfers.map((t) => t.lookalike)

afterEach(() => { vi.resetModules(); vi.clearAllMocks() })

async function transfersRoute(o: { enabled: boolean; served?: ReturnType<typeof rows>; stale?: boolean }) {
  vi.resetModules()
  vi.doMock('@/lib/providers', () => ({
    getDataProvider: () => ({
      kind: 'moralis',
      getAddressTokenTransfers: async () => o.stale
        ? { ok: false as const, reason: 'upstream_error' }
        : { ok: true as const, data: { transfers: rows(), cursor: null } },
    }),
    isBotRequest: () => false,
  }))
  vi.doMock('@/lib/internal-guard', () => ({ guardInternalAddress: async () => null }))
  vi.doMock('@/lib/backfill-trigger', () => ({
    backfillEnabled: () => o.enabled,
    enqueueBackfill: async () => {},
    shouldEnqueueBackfill: () => false,
  }))
  vi.doMock('@/lib/backfill-serve', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>)
    return {
      ...actual,
      readWatermark: async () => ({ status: 'complete', oldestCursor: null }),
      serveLocalTokenTransfers: async () => ({ rows: o.served ?? [], lastBoundary: null, hasMore: false }),
      transferCacheCoversFrom: async () => false,
    }
  })
  return await import('./transfers/route')
}
const get = async (route: Awaited<ReturnType<typeof transfersRoute>>, cursor?: string) =>
  (await route.GET(new Request(`https://x.test/api/internal/address/${ADDR}/transfers${cursor ? `?cursor=${cursor}` : ''}`), { params })).json()

describe('GET /api/internal/address/:address/transfers', () => {
  it('flags the impostor on the provider path while backfill is off', async () => {
    expect(verdicts(await get(await transfersRoute({ enabled: false })))).toEqual([USDT_FLAG, null, null])
  })

  it('flags the impostor on the live head with backfill on', async () => {
    expect(verdicts(await get(await transfersRoute({ enabled: true })))).toEqual([USDT_FLAG, null, null])
  })

  it('flags the impostor on a cached page', async () => {
    const { encodeCursor, TOP_TRANSFER_BOUNDARY } = await import('@/lib/backfill-serve')
    const local = encodeCursor(TOP_TRANSFER_BOUNDARY)
    const body = await get(await transfersRoute({ enabled: true, served: rows() }), local)
    expect(body.source).toBe('local')
    expect(verdicts(body)).toEqual([USDT_FLAG, null, null])
  })

  it('flags the impostor on the stale cached page served during a provider outage', async () => {
    const body = await get(await transfersRoute({ enabled: true, stale: true, served: rows() }))
    expect(body.stale).toBe(true)
    expect(verdicts(body)).toEqual([USDT_FLAG, null, null])
  })
})

describe('GET /api/internal/address/:address/holdings', () => {
  const balance = (tokenAddress: string, symbol: string, name: string) => ({
    tokenAddress, symbol, name, logo: null, decimals: 18, balance: '1', balanceFormatted: '0.000000000000000001', usdValue: null,
  })

  it('flags the impostor and leaves the rest of each row alone', async () => {
    vi.resetModules()
    const tokens = [balance(SPAM, 'US€DT', 'Some Token'), balance(BNB_USDT, 'USDT', 'Tether USD'), balance(SPAM, 'CAKE', 'PancakeSwap Token')]
    vi.doMock('@/lib/providers', () => ({ getDataProvider: () => ({ getAddressTokenBalances: async () => ({ ok: true, data: tokens }) }) }))
    vi.doMock('@/lib/internal-guard', () => ({ guardInternalAddress: async () => null }))
    const { GET } = await import('./holdings/route')
    const body = await (await GET(new Request(`https://x.test/api/internal/address/${ADDR}/holdings`), { params })).json()
    expect(body.limited).toBe(false)
    expect(body.tokens).toEqual(tokens.map((t, i) => ({ ...t, lookalike: [USDT_FLAG, null, null][i] })))
  })
})
