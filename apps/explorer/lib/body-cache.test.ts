import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTxBodyFromRpc, fetchTxInputFromRpc, getTxBody } from './body-cache'
import { getWebProvider } from './rpc'
import { kvGet, kvSet } from '@altscan/explorer-core'
import { serializeTxBody } from './body-cache-serde'

vi.mock('./rpc', () => ({ getWebProvider: vi.fn() }))
vi.mock('@altscan/explorer-core', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  getRedis: vi.fn(() => null),          // no Redis unless a test says so: kvSet's bounded in-memory fallback
  isRedisUnavailable: vi.fn(() => false),
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
    expect(ttlMs).toBeLessThanOrEqual(3 * 60 * 60 * 1000)
  })
})

// An indexed tx's stored input is cut at 500 chars; the page asks the node for the rest. That must not
// ride getTxBody's cache: those writes go to the noeviction Redis the Moralis CU ledger depends on.
describe('fetchTxInputFromRpc', () => {
  const FULL = '0x' + 'ab'.repeat(400)

  it("returns the node's input for the hash asked, and writes nothing to the shared cache", async () => {
    mockProvider({ tx: { hash: HASH, data: FULL } })
    expect(await fetchTxInputFromRpc(HASH)).toBe(FULL)
    expect(kvSet).not.toHaveBeenCalled()
    expect(kvGet).not.toHaveBeenCalled()
  })

  it('compares the hash ignoring letter case', async () => {
    mockProvider({ tx: { hash: HASH, data: FULL } })
    expect(await fetchTxInputFromRpc(HASH.toUpperCase().replace('0X', '0x'))).toBe(FULL)
  })

  it('is null when the node answers for another transaction', async () => {
    mockProvider({ tx: { hash: '0x' + 'cd'.repeat(32), data: FULL } })
    expect(await fetchTxInputFromRpc(HASH)).toBeNull()
  })

  it('is null when the node does not know the tx, or the call fails', async () => {
    mockProvider({ tx: null })
    expect(await fetchTxInputFromRpc(HASH)).toBeNull()
    mockProvider({ throws: true })
    expect(await fetchTxInputFromRpc(HASH)).toBeNull()
  })
})

// The TTL bounds how long an entry lives, not how many bytes arrive: a sender chooses a transaction's calldata and
// logs, and anyone can ask for pruned txs as fast as they like. All of it lands in the noeviction Redis the CU
// ledger needs.
describe('getTxBody byte bounds', () => {
  const TTL = 2 * 60 * 60 * 1000
  const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)
  /** A stand-in for ioredis' MULTI: INCRBY + PEXPIRE, run at exec. */
  function fakeRedis(fail?: 'oom' | 'closed') {
    const counts = new Map<string, number>()
    const expiries = new Map<string, number>()
    const client = {
      multi: () => {
        const ops: Array<() => [Error | null, unknown]> = []
        const chain = {
          incrby: (k: string, n: number) => {
            ops.push(() => {
              if (fail === 'oom') return [new Error("OOM command not allowed when used memory > 'maxmemory'."), null]
              counts.set(k, (counts.get(k) ?? 0) + n)
              return [null, counts.get(k)]
            })
            return chain
          },
          pexpire: (k: string, ms: number) => { ops.push(() => { expiries.set(k, ms); return [null, 1] }); return chain },
          exec: async () => { if (fail === 'closed') throw new Error('Connection is closed.'); return ops.map((op) => op()) },
        }
        return chain
      },
    }
    return { client, counts, expiries }
  }
  async function load(env: { windowBytes?: number } = {}) {
    vi.resetModules()
    delete process.env.BODY_CACHE_TTL_MS
    if (env.windowBytes === undefined) delete process.env.BODY_CACHE_WINDOW_BYTES
    else process.env.BODY_CACHE_WINDOW_BYTES = String(env.windowBytes)
    const mod = await import('./body-cache')
    const core = await import('@altscan/explorer-core')
    const rpc = await import('./rpc')
    vi.mocked(core.kvGet).mockResolvedValue(null)
    const withInput = (input: string) => vi.mocked(rpc.getWebProvider).mockResolvedValue({
      getTransaction: vi.fn(async () => ({ data: input })),
      getTransactionReceipt: vi.fn(async () => ({ logs: [] })),
    } as never)
    return { mod, core, withInput }
  }
  const bytesOf = (input: string) => Buffer.byteLength(serializeTxBody({ input, logs: [] }), 'utf8')

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers(); delete process.env.BODY_CACHE_WINDOW_BYTES })

  it('serves a body over the entry cap without caching or counting it', async () => {
    const { mod, core, withInput } = await load()
    const redis = fakeRedis()
    vi.mocked(core.getRedis).mockReturnValue(redis.client as never)
    const big = '0x' + 'ab'.repeat(mod.BODY_CACHE_MAX_ENTRY_BYTES / 2)
    withInput(big)
    expect((await mod.getTxBody(HASH))?.input).toBe(big)
    expect(core.kvSet).not.toHaveBeenCalled()
    expect(redis.counts.size).toBe(0)

    const atCap = '0x' + 'ab'.repeat((mod.BODY_CACHE_MAX_ENTRY_BYTES - bytesOf('0x')) / 2)
    expect(bytesOf(atCap)).toBe(mod.BODY_CACHE_MAX_ENTRY_BYTES)
    withInput(atCap)
    await mod.getTxBody(HASH)
    expect(core.kvSet).toHaveBeenCalledTimes(1)
  })

  it("admits bytes up to the window's budget, then nothing until the next window", async () => {
    const input = '0x' + 'cd'.repeat(500)
    const { mod: probe } = await load()
    const cost = bytesOf(input) + probe.BODY_CACHE_ENTRY_OVERHEAD_BYTES
    const { mod, core, withInput } = await load({ windowBytes: Math.floor(2.5 * cost) })
    const redis = fakeRedis()
    vi.mocked(core.getRedis).mockReturnValue(redis.client as never)
    withInput(input)
    for (let i = 0; i < 3; i++) await mod.getTxBody(HASH)
    expect(core.kvSet).toHaveBeenCalledTimes(2)
    const key = `body:admit:${Math.floor(T0 / TTL)}`
    expect(redis.counts.get(key)).toBe(3 * cost)
    expect(redis.expiries.get(key)).toBe(2 * TTL)   // the count outlives every entry it admitted

    vi.setSystemTime(T0 + TTL)
    await mod.getTxBody(HASH)
    expect(core.kvSet).toHaveBeenCalledTimes(3)
  })

  // A plain transfer's body is 24 bytes; its key and Redis's per-key structures cost several times that.
  it('charges each entry its per-key overhead, not just its value', async () => {
    const { mod: probe } = await load()
    const cost = bytesOf('0x') + probe.BODY_CACHE_ENTRY_OVERHEAD_BYTES
    const { mod, core, withInput } = await load({ windowBytes: 10 * cost })
    const redis = fakeRedis()
    vi.mocked(core.getRedis).mockReturnValue(redis.client as never)
    withInput('0x')
    for (let i = 0; i < 12; i++) await mod.getTxBody(HASH)
    expect(core.kvSet).toHaveBeenCalledTimes(10)
  })

  it.each(['oom', 'closed'] as const)('caches nothing when Redis cannot count it (%s)', async (fail) => {
    const { mod, core, withInput } = await load()
    vi.mocked(core.getRedis).mockReturnValue(fakeRedis(fail).client as never)
    withInput('0x01')
    expect((await mod.getTxBody(HASH))?.input).toBe('0x01')
    expect(core.kvSet).not.toHaveBeenCalled()
  })

  it("with no Redis, caches through kvSet's bounded in-memory fallback", async () => {
    const { mod, core, withInput } = await load()
    vi.mocked(core.getRedis).mockReturnValue(null)
    withInput('0x01')
    await mod.getTxBody(HASH)
    expect(core.kvSet).toHaveBeenCalledTimes(1)
  })
})
