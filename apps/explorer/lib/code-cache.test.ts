import { describe, expect, it } from 'vitest'
import { makeCodeClassCache } from './code-cache'

/**
 * Bounded, in-process cache for eth_getCode CLASSIFICATIONS.
 *
 * Why this exists: the address page reads searchParams and headers(), so it is
 * dynamically rendered on every request — `revalidate = 300` never protected it.
 * Deriving contract-ness from getCode therefore added one RPC call to every hit,
 * including crawler sweeps. Contract-ness is near-immutable, so it caches well.
 *
 * Two rules make it safe rather than merely fast:
 *  - only WELL-FORMED answers are stored, so a transient RPC outage can never
 *    poison the cache with a wrong verdict;
 *  - 'none' expires far sooner than 'code'. A contract effectively never stops
 *    being one, but an EOA becomes a contract every time someone deploys to a
 *    counterfactual CREATE2 address, which is routine with account abstraction.
 */
describe('makeCodeClassCache', () => {
  const mk = (now = { t: 0 }) => ({
    now,
    cache: makeCodeClassCache({ max: 3, codeTtlMs: 1000, noneTtlMs: 100, clock: () => now.t }),
  })

  it('misses, then hits', () => {
    const { cache } = mk()
    expect(cache.get('0xa')).toBeUndefined()
    cache.set('0xa', 'code')
    expect(cache.get('0xa')).toBe('code')
  })

  it('expires a contract entry only after the LONG ttl', () => {
    const now = { t: 0 }; const { cache } = mk(now)
    cache.set('0xa', 'code')
    now.t = 999
    expect(cache.get('0xa')).toBe('code')
    now.t = 1001
    expect(cache.get('0xa')).toBeUndefined()
  })

  it('expires an EOA entry on the SHORT ttl — deployments happen', () => {
    // A CREATE2 deploy turns a known-empty address into a contract. Holding
    // 'none' for as long as we hold 'code' would render a live contract as an
    // EOA for hours.
    const now = { t: 0 }; const { cache } = mk(now)
    cache.set('0xa', 'none')
    now.t = 99
    expect(cache.get('0xa')).toBe('none')
    now.t = 101
    expect(cache.get('0xa')).toBeUndefined()
  })

  it('REFUSES to store a malformed verdict — an outage must not poison it', () => {
    const { cache } = mk()
    // @ts-expect-error deliberately passing the value the cache must reject
    cache.set('0xa', 'malformed')
    expect(cache.get('0xa')).toBeUndefined()
  })

  it('stays bounded, evicting the oldest', () => {
    const { cache } = mk()
    cache.set('0xa', 'code'); cache.set('0xb', 'code'); cache.set('0xc', 'code')
    cache.set('0xd', 'code')            // max = 3 → 0xa evicted
    expect(cache.size()).toBe(3)
    expect(cache.get('0xa')).toBeUndefined()
    expect(cache.get('0xd')).toBe('code')
  })

  it('is LRU, not FIFO — a re-read keeps an entry alive', () => {
    const { cache } = mk()
    cache.set('0xa', 'code'); cache.set('0xb', 'code'); cache.set('0xc', 'code')
    expect(cache.get('0xa')).toBe('code')   // touch → 0xa becomes newest
    cache.set('0xd', 'code')                // 0xb is now the oldest
    expect(cache.get('0xa')).toBe('code')
    expect(cache.get('0xb')).toBeUndefined()
  })

  it('never grows past max under a crawler-style sweep of distinct addresses', () => {
    const { cache } = mk()
    for (let i = 0; i < 5000; i++) cache.set(`0x${i}`, 'code')
    expect(cache.size()).toBe(3)
  })

  it('an expired entry does not occupy a slot forever', () => {
    const now = { t: 0 }; const { cache } = mk(now)
    cache.set('0xa', 'code')
    now.t = 2000
    expect(cache.get('0xa')).toBeUndefined()
    expect(cache.size()).toBe(0)          // purged on read, not merely hidden
  })

  it('keys are case-normalized so 0xAB and 0xab are one entry', () => {
    const { cache } = mk()
    cache.set('0xAB', 'code')
    expect(cache.get('0xab')).toBe('code')
  })
})
