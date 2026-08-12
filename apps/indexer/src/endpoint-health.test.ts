import { describe, it, expect } from 'vitest'
import { createEndpointHealth, DEFAULT_DEMOTE_AFTER } from './endpoint-health'

/**
 * bsc.publicnode.com serves recent blocks but 403s archive requests, which the
 * indexer only makes once it is ALREADY behind — so with round-robin starts it
 * taxed ~1/3 of blocks an 8s timeout exactly when throughput mattered most.
 * These pin the properties that make demotion safe: it never drops an endpoint,
 * it never lasts forever, and it does not let one class of request vouch for
 * another.
 */
const P = { a: 'A', b: 'B', c: 'C' }
const ALL = [P.a, P.b, P.c]

describe('createEndpointHealth', () => {
  it('keeps plain round-robin while everything is healthy', () => {
    const h = createEndpointHealth<string>()
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
    expect(h.order(ALL, 1, 'block')).toEqual(['B', 'C', 'A'])
    expect(h.order(ALL, 2, 'block')).toEqual(['C', 'A', 'B'])
  })

  it('demotes a repeatedly-failing endpoint to LAST', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
    expect(h.order(ALL, 1, 'block')).toEqual(['B', 'C', 'A'])
  })

  it('does not demote before the threshold', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER - 1; i++) h.recordFailure(P.a, 'block')
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
  })

  it('NEVER drops an endpoint — every order is a permutation of the pool', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < 50; i++) for (const p of ALL) h.recordFailure(p, 'block')
    for (let s = 0; s < 5; s++) {
      expect([...h.order(ALL, s, 'block')].sort()).toEqual(['A', 'B', 'C'])
    }
  })

  it('falls back to plain rotation when ALL endpoints are sick', () => {
    // "Everything is failing" must still mean "try them", not "try nothing".
    const h = createEndpointHealth<string>()
    for (const p of ALL) for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(p, 'block')
    expect(h.order(ALL, 1, 'block')).toEqual(['B', 'C', 'A'])
  })

  it('lifts the demotion after the cooldown', () => {
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, now: () => t })
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
    t += 10_001
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
  })

  /**
   * The never-drop invariant has to hold under a MOVING clock, not just a frozen
   * one. order() used to call isDemoted() once per partition; with the cooldown
   * expiring between those two reads, an endpoint counted as demoted by the first
   * and healthy by the second, landing in neither list and vanishing from the
   * pool — exactly as it recovered. Every fixed-clock test above passes anyway,
   * which is why this one advances time on each call. (codex P2, round 3.)
   */
  it('never drops an endpoint even if the cooldown expires mid-call', () => {
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, now: () => { t += 6_000; return t } })
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    for (let i = 0; i < 12; i++) {
      expect([...h.order(ALL, 0, 'block')].sort()).toEqual(['A', 'B', 'C'])
    }
  })

  it('a single success clears the streak immediately', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    expect(h.demoted(ALL, 'block')).toEqual(['A'])
    h.recordSuccess(P.a, 'block')
    expect(h.demoted(ALL, 'block')).toEqual([])
  })

  /**
   * The motivating endpoint answers getBlockNumber() perfectly while 403ing
   * archive block fetches. With one pooled streak, every successful tip read
   * wiped the archive failures, the demotion never stuck, and the feature did
   * nothing for the exact endpoint it was built for. (codex P2, round 3.)
   */
  it('does not let a successful READ clear a BLOCK-fetch failure streak', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    h.recordSuccess(P.a, 'read')     // tip reads keep succeeding
    h.recordSuccess(P.a, 'read')
    expect(h.demoted(ALL, 'block')).toEqual(['A'])
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
  })

  it('keeps an endpoint in normal rotation for the class it still serves', () => {
    // Demoting it for reads too would throw away capacity it genuinely has.
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    expect(h.order(ALL, 0, 'read')).toEqual(['A', 'B', 'C'])
    expect(h.demoted(ALL, 'read')).toEqual([])
  })

  it('handles an empty pool and a single endpoint', () => {
    const h = createEndpointHealth<string>()
    expect(h.order([], 0, 'block')).toEqual([])
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    // The only endpoint we have is still the one we must use.
    expect(h.order([P.a], 0, 'block')).toEqual(['A'])
  })
})
