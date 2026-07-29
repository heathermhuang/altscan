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
    constructor(public req: FakeFetchRequest) {}
    on(_event: string, fn: () => void) {
      this.handlers.push(fn)
      return this
    }
    /** Fire the 'error' handler the way ethers would on a transport failure. */
    emitError() {
      for (const h of this.handlers) h()
    }
  }
  return { FakeFetchRequest, FakeJsonRpcProvider }
})
type FakeJsonRpcProvider = InstanceType<typeof fakes.FakeJsonRpcProvider>

vi.mock('ethers', () => ({
  JsonRpcProvider: fakes.FakeJsonRpcProvider,
  FetchRequest: fakes.FakeFetchRequest,
}))
vi.mock('./settings', () => ({ getSetting: vi.fn(async () => null) }))

const g = globalThis as typeof globalThis & { __explorer_provider?: unknown }
const asFake = (p: unknown) => p as unknown as FakeJsonRpcProvider

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
})
