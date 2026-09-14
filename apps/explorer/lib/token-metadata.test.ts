import { describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => {
  const behaviours = new Map<string, { symbol: () => Promise<unknown>; decimals: () => Promise<unknown> }>()
  class FakeContract {
    constructor(public target: string, _abi: unknown, _provider: unknown) {}
    symbol() { return behaviours.get(this.target)!.symbol() }
    decimals() { return behaviours.get(this.target)!.decimals() }
  }
  return { FakeContract, behaviours }
})

vi.mock('ethers', () => ({ Contract: fakes.FakeContract }))
vi.mock('./rpc', () => ({ getWebProvider: vi.fn(async () => ({})) }))
vi.mock('./cache-registry', () => ({ registerCache: vi.fn() }))
vi.mock('./observability', () => ({ swallow: vi.fn() }))

import { fetchTokenMetadata } from './token-metadata'
import { swallow } from './observability'

const addrOf = (n: string) => '0x' + n.repeat(40)

describe('fetchTokenMetadata observability', () => {
  it('reports WHY a token could not be resolved rather than failing silently', async () => {
    const addr = addrOf('1')
    fakes.behaviours.set(addr, {
      symbol: () => Promise.reject(new Error('could not coalesce error: -32005 rate limit exceeded')),
      decimals: () => Promise.reject(new Error('could not coalesce error: -32005 rate limit exceeded')),
    })

    const out = await fetchTokenMetadata([addr])

    // degradation is unchanged: the address is simply absent
    expect(out.has(addr)).toBe(false)
    expect(swallow).toHaveBeenCalled()
    const [tag, err] = vi.mocked(swallow).mock.calls[0]
    expect(tag).toBe('token/metadata')
    expect(String((err as Error).message)).toContain('rate limit')
  })

  it('stays quiet when the token resolves', async () => {
    vi.mocked(swallow).mockClear()
    const addr = addrOf('2')
    fakes.behaviours.set(addr, {
      symbol: () => Promise.resolve('USDT'),
      decimals: () => Promise.resolve(18),
    })

    const out = await fetchTokenMetadata([addr])

    expect(out.get(addr)).toEqual({ symbol: 'USDT', decimals: 18 })
    expect(swallow).not.toHaveBeenCalled()
  })
})

// ethers reports a revert as CALL_EXCEPTION; timeouts, rate limits and 5xx carry other codes.
const revert = () => Promise.reject(Object.assign(
  new Error('execution reverted (no data present; likely require(false) occurred'), { code: 'CALL_EXCEPTION' }))
const timeout = () => Promise.reject(Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }))

/** Wire an address to fake calls and count every call made to it. */
function stub(addr: string, symbol: () => Promise<unknown>, decimals: () => Promise<unknown>) {
  const calls = { n: 0 }
  fakes.behaviours.set(addr, {
    symbol: () => { calls.n++; return symbol() },
    decimals: () => { calls.n++; return decimals() },
  })
  return calls
}

describe('fetchTokenMetadata caching', () => {
  // A contract whose symbol()/decimals() revert does so on every call, so asking
  // again on each visit only re-logs the same revert.
  it('caches a token whose symbol() and decimals() both revert, so a revisit neither re-asks nor re-logs', async () => {
    vi.mocked(swallow).mockClear()
    const addr = addrOf('3')
    const calls = stub(addr, revert, revert)

    expect((await fetchTokenMetadata([addr])).has(addr)).toBe(false)
    expect(swallow).toHaveBeenCalledTimes(1)

    expect((await fetchTokenMetadata([addr])).has(addr)).toBe(false)
    expect(calls.n).toBe(2)
    expect(swallow).toHaveBeenCalledTimes(1)
  })

  it('never caches a transport failure: the next request asks again', async () => {
    const addr = addrOf('4')
    const calls = stub(addr, timeout, timeout)
    await fetchTokenMetadata([addr])
    await fetchTokenMetadata([addr])
    expect(calls.n).toBe(4)
  })

  it('does not cache a revert paired with a transport failure', async () => {
    const addr = addrOf('5')
    const calls = stub(addr, revert, timeout)
    await fetchTokenMetadata([addr])
    await fetchTokenMetadata([addr])
    expect(calls.n).toBe(4)
  })

  // symbol() answered but decimals() timed out. Caching that would pin an
  // unscaled amount on the page for the whole TTL.
  it('does not cache a partial answer whose other call hit a transport failure', async () => {
    const addr = addrOf('6')
    const calls = stub(addr, () => Promise.resolve('ABC'), timeout)
    expect((await fetchTokenMetadata([addr])).get(addr)).toEqual({ symbol: 'ABC', decimals: null })
    await fetchTokenMetadata([addr])
    expect(calls.n).toBe(4)
  })

  it('caches a partial answer whose other call reverted', async () => {
    const addr = addrOf('7')
    const calls = stub(addr, () => Promise.resolve('ABC'), revert)
    await fetchTokenMetadata([addr])
    expect((await fetchTokenMetadata([addr])).get(addr)).toEqual({ symbol: 'ABC', decimals: null })
    expect(calls.n).toBe(2)
  })
})
