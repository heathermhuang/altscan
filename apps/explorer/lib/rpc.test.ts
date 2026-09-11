import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWebProvider } from './rpc'
import { getSetting } from './settings'

// ethers is mocked so constructing a provider never touches the network; the
// fakes keep just enough shape for the identity/keying assertions below.
// vi.hoisted because vi.mock factories are hoisted above module-level consts.
const fakes = vi.hoisted(() => {
  class FakeFetchRequest {
    timeout = 0
    constructor(public url: string) {}
  }
  class FakeJsonRpcProvider {
    handlers: Array<() => void> = []
    constructor(
      public req: FakeFetchRequest,
      public network?: unknown,
      public options?: { batchMaxCount?: number },
    ) {}
    on(_event: string, fn: () => void) {
      this.handlers.push(fn)
      return this
    }
    /** Fire the 'error' handler the way ethers would on a transport failure. */
    emitError() {
      for (const h of this.handlers) h()
    }
  }
  class FakeFallbackProvider {
    handlers: Array<() => void> = []
    constructor(
      public configs: Array<{ provider: FakeJsonRpcProvider; priority: number; weight: number }>,
      public network: unknown,
      public options: { quorum?: number },
    ) {}
    on(_event: string, fn: () => void) {
      this.handlers.push(fn)
      return this
    }
    emitError() { for (const h of this.handlers) h() }
  }
  return { FakeFetchRequest, FakeJsonRpcProvider, FakeFallbackProvider }
})
type FakeJsonRpcProvider = InstanceType<typeof fakes.FakeJsonRpcProvider>
type FakeFallbackProvider = InstanceType<typeof fakes.FakeFallbackProvider>

vi.mock('ethers', () => ({
  JsonRpcProvider: fakes.FakeJsonRpcProvider,
  FallbackProvider: fakes.FakeFallbackProvider,
  FetchRequest: fakes.FakeFetchRequest,
}))
vi.mock('./settings', () => ({ getSetting: vi.fn(async () => null) }))

const g = globalThis as typeof globalThis & { __explorer_provider?: unknown }
const asFake = (p: unknown) => p as unknown as FakeJsonRpcProvider
const asFallback = (p: unknown) => p as unknown as FakeFallbackProvider

beforeEach(() => {
  g.__explorer_provider = null
  vi.mocked(getSetting).mockReset()
  vi.mocked(getSetting).mockResolvedValue(null as never)
  delete process.env.RPC_TIMEOUT_MS
})

describe('getWebProvider', () => {
  it('reuses the singleton while url and timeout are unchanged', async () => {
    const a = await getWebProvider()
    const b = await getWebProvider()
    expect(b).toBe(a)
  })

  it('rebuilds when the override changes the url, and applies the new url + timeout', async () => {
    const first = await getWebProvider()
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://override.test', rpcTimeoutMs: 12000 } as never)
    const second = await getWebProvider()

    expect(second).not.toBe(first)
    expect(asFake(second).req.url).toBe('https://override.test')
    expect(asFake(second).req.timeout).toBe(12000)
  })

  it('rebuilds when only the timeout changes', async () => {
    const first = await getWebProvider()
    vi.mocked(getSetting).mockResolvedValue({ rpcTimeoutMs: 20000 } as never)
    const second = await getWebProvider()

    expect(second).not.toBe(first)
    expect(asFake(second).req.url).toBe(asFake(first).req.url)
    expect(asFake(second).req.timeout).toBe(20000)
  })

  it('falls back to env/default when the settings loader returns null', async () => {
    // getSetting swallows its own failures and returns null; that must resolve
    // to a usable provider rather than propagating.
    const p = await getWebProvider()
    expect(asFake(p).req.url).toMatch(/^https:\/\//)
    expect(asFake(p).req.timeout).toBe(8000)
  })

  it('clears the singleton when the CURRENT provider errors', async () => {
    const p = await getWebProvider()
    asFake(p).emitError()
    expect(g.__explorer_provider).toBeNull()

    const rebuilt = await getWebProvider()
    expect(rebuilt).not.toBe(p)
  })

  it('does not block on a stalled settings lookup — serves the last-known-good provider', async () => {
    const warm = await getWebProvider()

    // Simulate a hung DB read: getSetting never settles.
    vi.mocked(getSetting).mockReturnValue(new Promise(() => {}) as never)
    const started = Date.now()
    const p = await getWebProvider()

    expect(p).toBe(warm)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('falls back to env/default when settings stall with no provider built yet', async () => {
    vi.mocked(getSetting).mockReturnValue(new Promise(() => {}) as never)
    const p = await getWebProvider()

    expect(asFake(p).req.url).toMatch(/^https:\/\//)
    expect(asFake(p).req.timeout).toBe(8000)
  })

  it("does not let a stale provider's late error wipe a newer one", async () => {
    const stale = await getWebProvider()
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://override.test' } as never)
    const fresh = await getWebProvider()
    expect(fresh).not.toBe(stale)

    asFake(stale).emitError() // arrives after the rebuild

    expect(g.__explorer_provider).not.toBeNull()
    expect(await getWebProvider()).toBe(fresh)
  })

  it('keeps a single url on a plain provider — no failover wrapper', async () => {
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://solo.test' } as never)
    const p = await getWebProvider()
    expect(asFake(p).req.url).toBe('https://solo.test')
  })

  it('builds a failover provider across several urls, in order, first-success wins', async () => {
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://a.test,https://b.test' } as never)
    const p = await getWebProvider()

    expect(asFallback(p).configs.map((c) => c.provider.req.url)).toEqual([
      'https://a.test', 'https://b.test',
    ])
    // quorum 1 = take the first endpoint that answers. The ethers default would
    // issue every call to two endpoints and wait for agreement, doubling load
    // on public RPCs to buy a consensus the explorer does not need.
    expect(asFallback(p).options.quorum).toBe(1)
  })

  it('applies the resolved timeout to every endpoint in the list', async () => {
    vi.mocked(getSetting).mockResolvedValue(
      { webRpcUrl: 'https://a.test,https://b.test', rpcTimeoutMs: 4500 } as never)
    const p = await getWebProvider()
    expect(asFallback(p).configs.map((c) => c.provider.req.timeout)).toEqual([4500, 4500])
  })

  it('rebuilds when the url LIST changes, not just the first entry', async () => {
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://a.test' } as never)
    const first = await getWebProvider()
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://a.test,https://b.test' } as never)
    const second = await getWebProvider()
    expect(second).not.toBe(first)
  })

  // drpc's free plan rejects any JSON-RPC batch over 3 with a 500 for the WHOLE
  // batch. This provider is a process-wide singleton, so calls from concurrent
  // page renders coalesce into one batch whose size grows with traffic.
  it('never batches: every call goes out as its own request', async () => {
    const p = await getWebProvider()
    expect(asFake(p).options?.batchMaxCount).toBe(1)
  })

  it('never batches on any endpoint of a failover list either', async () => {
    vi.mocked(getSetting).mockResolvedValue({ webRpcUrl: 'https://a.test,https://b.test' } as never)
    const p = await getWebProvider()
    expect(asFallback(p).configs.map((c) => c.provider.options?.batchMaxCount)).toEqual([1, 1])
  })
})
