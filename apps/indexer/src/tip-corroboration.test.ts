import { describe, it, expect } from 'vitest'
import { corroborateTip, corroboratorsFor, providerDomain, type HeaderSource } from './tip-corroboration'

const HASH = '0x' + 'ab'.repeat(32)
const OTHER = '0x' + 'cd'.repeat(32)
const H = 50_000_000

/** Answers getBlock from a fixed chain view; `hang` never answers. */
const endpoint = (chain: Record<number, string>, hang = false): HeaderSource & { asked: number[] } => {
  const asked: number[] = []
  return {
    asked,
    getBlock: async (h: number) => {
      asked.push(h)
      if (hang) return new Promise<never>(() => {})
      return chain[h] ? { hash: chain[h] } : null
    },
  }
}

describe('providerDomain', () => {
  it('reduces a hostname to its last two labels', () => {
    expect(providerDomain('https://bsc-dataseed1.binance.org/')).toBe('binance.org')
    expect(providerDomain('https://nd-123-456.p2pify.com/abc')).toBe('p2pify.com')
  })
  it('keeps an IP address whole', () => {
    expect(providerDomain('http://10.0.0.7:8545')).toBe('10.0.0.7')
    expect(providerDomain('http://[::1]:8545')).toBe('[::1]')
  })
})

describe('corroboratorsFor', () => {
  const a = endpoint({}), b = endpoint({}), c = endpoint({})

  it('prefers endpoints on another provider', () => {
    const list = [
      { provider: a, url: 'https://eth.drpc.org/k' },
      { provider: b, url: 'https://ethereum-mainnet.core.chainstack.com/k' },
    ]
    expect(corroboratorsFor(a, list)).toEqual({ providers: [b], level: 'provider' })
  })

  it('falls back to another hostname when every endpoint is on one provider', () => {
    const list = [
      { provider: a, url: 'https://bsc-dataseed1.binance.org/' },
      { provider: b, url: 'https://bsc-dataseed2.binance.org/' },
      { provider: c, url: 'https://bsc-dataseed3.binance.org/' },
    ]
    expect(corroboratorsFor(b, list)).toEqual({ providers: [a, c], level: 'host' })
  })

  it('finds nobody when every endpoint shares the hostname', () => {
    const list = [
      { provider: a, url: 'https://rpc.example.com/key1' },
      { provider: b, url: 'https://rpc.example.com/key2' },
    ]
    expect(corroboratorsFor(a, list)).toEqual({ providers: [], level: 'none' })
    expect(corroboratorsFor(a, [list[0]])).toEqual({ providers: [], level: 'none' })
  })
})

describe('corroborateTip', () => {
  it('passes when another endpoint holds the landing block with the same hash', async () => {
    const other = endpoint({ [H]: HASH.toUpperCase().replace('0X', '0x') })
    expect(await corroborateTip(endpoint({ [H]: HASH }), H, [other], 1_000)).toBeNull()
    expect(other.asked).toEqual([H])
  })

  it('refuses an inflated tip: no other endpoint has the landing block', async () => {
    expect(await corroborateTip(endpoint({ [H]: HASH }), H, [endpoint({})], 1_000)).toMatch(/no other endpoint has block/)
  })

  it('refuses when the landing block differs between endpoints', async () => {
    expect(await corroborateTip(endpoint({ [H]: HASH }), H, [endpoint({ [H]: OTHER })], 1_000)).toMatch(/differs/)
  })

  it('refuses when the reporting endpoint cannot show the block itself', async () => {
    expect(await corroborateTip(endpoint({}), H, [endpoint({ [H]: HASH })], 1_000)).toMatch(/reported the tip has no block/)
  })

  it('refuses with nobody to ask', async () => {
    expect(await corroborateTip(endpoint({ [H]: HASH }), H, [], 1_000)).toMatch(/no other block endpoint/)
  })

  it('refuses, and never throws, when a header read times out or fails', async () => {
    expect(await corroborateTip(endpoint({ [H]: HASH }), H, [endpoint({}, true)], 20)).toMatch(/header read failed/)
    const broken: HeaderSource = { getBlock: async () => { throw new Error('ECONNRESET') } }
    expect(await corroborateTip(broken, H, [endpoint({ [H]: HASH })], 1_000)).toMatch(/header read failed/)
  })
})
