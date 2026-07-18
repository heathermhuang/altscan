import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A4b-1 ships DARK. The entire safety argument is that with
 * `provider.backfill.enabled === false` the history and transfers routes behave
 * EXACTLY as they did in A4a. This file pins that claim.
 *
 * The specific trap being guarded: if the gated-off path fell through to the
 * shared body instead of returning early, the caller's opaque provider cursor
 * would be handed to `decodeCursor`, which cannot parse it and therefore yields
 * `{source:'head'}` → `provCursor === undefined` → the provider silently
 * restarts at page 1. Users would see page 2 of a long history render page 1
 * forever, with no error anywhere. That is a data-correctness bug that no
 * typecheck or build can catch.
 */

const OPAQUE = 'eyJhbGciOiJIUzI1NiJ9.provider-cursor.abc123'

function makeProvider() {
  const seen: Array<string | undefined> = []
  return {
    seen,
    adapter: {
      kind: 'moralis',
      getAddressHistory: vi.fn(async (_addr: string, cursor?: string) => {
        seen.push(cursor)
        return {
          ok: true as const,
          data: {
            txs: [{
              hash: '0xaaa', blockNumber: '100', blockTimestamp: '2026-07-18T00:00:00Z',
              fromAddress: '0xf', toAddress: '0xt', value: '1', gasPrice: '1', gasUsed: '1',
              category: 'send', summary: 's', possibleSpam: false, erc20Transfers: [],
            }],
            cursor: 'NEXT_PROVIDER_CURSOR',
            totalTxs: 999,
          },
        }
      }),
      getAddressTokenTransfers: vi.fn(async (_addr: string, cursor?: string) => {
        seen.push(cursor)
        return { ok: true as const, data: { transfers: [], cursor: 'NEXT_PROVIDER_CURSOR' } }
      }),
    },
  }
}

async function loadRoute(enabled: boolean, provider: ReturnType<typeof makeProvider>) {
  vi.resetModules()
  vi.doMock('@/lib/providers', () => ({
    getDataProvider: () => provider.adapter,
    isBotRequest: () => false,
  }))
  vi.doMock('@/lib/internal-guard', () => ({ guardInternalAddress: async () => null }))
  vi.doMock('@/lib/backfill-trigger', () => ({
    backfillEnabled: () => enabled,
    enqueueBackfill: async () => {},
    shouldEnqueueBackfill: () => false,
  }))
  // Any DB touch in a dark-ship run is itself a failure — see the test below.
  vi.doMock('@/lib/backfill-serve', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>)
    return {
      ...actual,
      readWatermark: vi.fn(async () => { throw new Error('DB touched while backfill disabled') }),
    }
  })
  return await import('@/app/api/internal/address/[address]/history/route')
}

afterEach(() => { vi.resetModules(); vi.clearAllMocks() })

describe('A4b-1 dark ship — history route with backfill disabled', () => {
  const ADDR = '0x1111111111111111111111111111111111111111'
  const req = (cursor?: string) =>
    new Request(`https://x.test/api/internal/address/${ADDR}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
  const params = Promise.resolve({ address: ADDR })

  it('passes an opaque provider cursor through UNCHANGED', async () => {
    const p = makeProvider()
    const { GET } = await loadRoute(false, p)
    await GET(req(OPAQUE), { params })
    // Not undefined, not re-encoded — the exact string the client sent.
    expect(p.seen).toEqual([OPAQUE])
  })

  it('returns the provider cursor UNWRAPPED (no base64 envelope)', async () => {
    const p = makeProvider()
    const { GET } = await loadRoute(false, p)
    const res = await GET(req(), { params })
    const body = await res.json()
    expect(body.cursor).toBe('NEXT_PROVIDER_CURSOR')
  })

  it('returns full ProviderTx rows, not the reduced projection', async () => {
    // A4a clients receive gasPrice/erc20Transfers; dropping them while dark
    // would be a silent contract change.
    const p = makeProvider()
    const { GET } = await loadRoute(false, p)
    const body = await (await GET(req(), { params })).json()
    expect(body.result[0]).toHaveProperty('gasPrice')
    expect(body.result[0]).toHaveProperty('erc20Transfers')
    expect(body.source).toBeUndefined()
  })

  it('never touches the database while disabled', async () => {
    // readWatermark is mocked to throw; reaching it would surface here.
    const p = makeProvider()
    const { GET } = await loadRoute(false, p)
    const res = await GET(req(OPAQUE), { params })
    expect(res.status).toBe(200)
  })
})

describe('A4b-1 enabled — the cursor contract changes deliberately', () => {
  const ADDR = '0x2222222222222222222222222222222222222222'
  const params = Promise.resolve({ address: ADDR })

  it('wraps the provider cursor once backfill is enabled', async () => {
    const p = makeProvider()
    vi.resetModules()
    vi.doMock('@/lib/providers', () => ({
      getDataProvider: () => p.adapter,
      isBotRequest: () => false,
    }))
    vi.doMock('@/lib/internal-guard', () => ({ guardInternalAddress: async () => null }))
    vi.doMock('@/lib/backfill-trigger', () => ({
      backfillEnabled: () => true,
      enqueueBackfill: async () => {},
      shouldEnqueueBackfill: () => false,
    }))
    vi.doMock('@/lib/backfill-serve', async (orig) => {
      const actual = await (orig() as Promise<Record<string, unknown>>)
      return { ...actual, readWatermark: vi.fn(async () => null) }  // no cache yet
    })
    const { GET } = await import('@/app/api/internal/address/[address]/history/route')
    const body = await (await GET(
      new Request(`https://x.test/api/internal/address/${ADDR}/history`), { params },
    )).json()

    // Enabled → the cursor becomes an envelope, and the rows become HistoryRow.
    expect(body.cursor).not.toBe('NEXT_PROVIDER_CURSOR')
    const decoded = JSON.parse(Buffer.from(body.cursor, 'base64url').toString('utf8'))
    expect(decoded).toEqual({ source: 'provider', providerCursor: 'NEXT_PROVIDER_CURSOR' })
    expect(body.result[0]).not.toHaveProperty('gasPrice')
    expect(body.source).toBe('provider')
  })
})
