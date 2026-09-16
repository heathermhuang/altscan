import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTxBodyFromRpc, getTxBody } from './body-cache'
import { getWebProvider } from './rpc'
import { kvGet, kvSet } from '@altscan/explorer-core'
import { serializeTxBody } from './body-cache-serde'

vi.mock('./rpc', () => ({ getWebProvider: vi.fn() }))
vi.mock('@altscan/explorer-core', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
}))

const HASH = '0x' + 'ab'.repeat(32)

const rpcLog = {
  address: '0xAbCdEf0000000000000000000000000000000001',
  topics: ['0xt0', '0xt1'],
  data: '0x01',
  index: 3,
}

function mockProvider(opts: { tx?: unknown; receipt?: unknown; throws?: boolean }) {
  vi.mocked(getWebProvider).mockResolvedValue({
    getTransaction: vi.fn(async () => {
      if (opts.throws) throw new Error('rpc down')
      return opts.tx ?? null
    }),
    getTransactionReceipt: vi.fn(async () => {
      if (opts.throws) throw new Error('rpc down')
      return opts.receipt ?? null
    }),
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(kvGet).mockResolvedValue(null)
})

describe('fetchTxBodyFromRpc', () => {
  it('returns input + normalized logs when tx AND receipt are present', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: { logs: [rpcLog] } })
    expect(await fetchTxBodyFromRpc(HASH)).toEqual({
      input: '0xdeadbeef',
      logs: [{
        address: '0xabcdef0000000000000000000000000000000001',
        topic0: '0xt0', topic1: '0xt1', topic2: null, topic3: null,
        data: '0x01', logIndex: 3,
      }],
    })
  })

  it('a missing receipt is a FAILURE, not an empty-logs success', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: null })
    expect(await fetchTxBodyFromRpc(HASH)).toBeNull()
  })

  it('a missing tx is a failure even if the receipt is present', async () => {
    mockProvider({ tx: null, receipt: { logs: [rpcLog] } })
    expect(await fetchTxBodyFromRpc(HASH)).toBeNull()
  })

  it('returns null when the provider throws', async () => {
    mockProvider({ throws: true })
    expect(await fetchTxBodyFromRpc(HASH)).toBeNull()
  })
})

describe('getTxBody caching', () => {
  it('serves from cache without touching the provider', async () => {
    vi.mocked(kvGet).mockResolvedValue(serializeTxBody({ input: '0x01', logs: [] }))
    mockProvider({ throws: true })
    expect(await getTxBody(HASH)).toEqual({ input: '0x01', logs: [] })
    expect(getWebProvider).not.toHaveBeenCalled()
  })

  it('caches a successful fetch', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: { logs: [] } })
    const body = await getTxBody(HASH)
    expect(body?.input).toBe('0xdeadbeef')
    expect(kvSet).toHaveBeenCalledTimes(1)
  })

  it('never caches a partial/failed fetch (retry stays possible)', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: null })
    expect(await getTxBody(HASH)).toBeNull()
    expect(kvSet).not.toHaveBeenCalled()
  })
})

describe('getTxBody TTL bound', () => {
  /**
   * The default was 7 days with no bound on key COUNT, and on 2026-09-08 that
   * filled ethscan-redis (172,133 of 172,218 keys were `body:tx:*`, ~435MB of
   * demand against a 256MB instance); bnbscan-redis had been pinned for longer
   * still. Those instances are maxmemory-policy=noeviction, so a full instance
   * REFUSES writes rather than evicting — which took down the Moralis CU ledger
   * (`INCRBY` inside the admission script returned OOM, so the monthly ceiling
   * could no longer record spend or bind) and the Moralis response cache with it.
   *
   * This cache is a convenience over immutable RPC data for retention-pruned
   * txs; the page refetches transparently on a miss. It must never be able to
   * consume the instance that the spend ceiling depends on, so the default is
   * sized to fit rather than to maximise hit rate. Overridable via
   * BODY_CACHE_TTL_MS, but raising it past a day needs a bigger Redis first.
   */
  it('defaults to a TTL the shared Redis can hold, not 7 days', async () => {
    vi.resetModules()
    delete process.env.BODY_CACHE_TTL_MS
    const fresh = await import('./body-cache')
    const freshCore = await import('@altscan/explorer-core')
    const freshRpc = await import('./rpc')
    vi.mocked(freshCore.kvGet).mockResolvedValue(null)
    vi.mocked(freshRpc.getWebProvider).mockResolvedValue({
      getTransaction: vi.fn(async () => ({ data: '0xdeadbeef' })),
      getTransactionReceipt: vi.fn(async () => ({ logs: [] })),
    } as never)

    await fresh.getTxBody(HASH)

    const ttlMs = vi.mocked(freshCore.kvSet).mock.calls.at(-1)?.[2]
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})
