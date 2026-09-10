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
