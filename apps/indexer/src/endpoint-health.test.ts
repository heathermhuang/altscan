import { describe, it, expect } from 'vitest'
import { createEndpointHealth, DEFAULT_DEMOTE_AFTER } from './endpoint-health'

/**
 * bsc.publicnode.com serves recent blocks but 403s archive requests, which the
 * indexer only makes once it is ALREADY behind — so with round-robin starts it
 * taxed ~1/3 of blocks an 8s timeout exactly when throughput mattered most.
 * These pin the two properties that make demotion safe: it never drops an
 * endpoint, and it never lasts forever.
 */
const P = { a: 'A', b: 'B', c: 'C' }
const ALL = [P.a, P.b, P.c]

describe('createEndpointHealth', () => {
  it('keeps plain round-robin while everything is healthy', () => {
    const h = createEndpointHealth<string>()
    expect(h.order(ALL, 0)).toEqual(['A', 'B', 'C'])
    expect(h.order(ALL, 1)).toEqual(['B', 'C', 'A'])
    expect(h.order(ALL, 2)).toEqual(['C', 'A', 'B'])
  })

  it('demotes a repeatedly-failing endpoint to LAST', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a)
    // A is no longer tried first even when the rotation starts on it.
    expect(h.order(ALL, 0)).toEqual(['B', 'C', 'A'])
    expect(h.order(ALL, 1)).toEqual(['B', 'C', 'A'])
  })

  it('does not demote before the threshold', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER - 1; i++) h.recordFailure(P.a)
    expect(h.order(ALL, 0)).toEqual(['A', 'B', 'C'])
  })

  it('NEVER drops an endpoint — every order is a permutation of the pool', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < 50; i++) { h.recordFailure(P.a); h.recordFailure(P.b); h.recordFailure(P.c) }
    for (let s = 0; s < 5; s++) {
      expect([...h.order(ALL, s)].sort()).toEqual(['A', 'B', 'C'])
    }
  })

  it('falls back to plain rotation when ALL endpoints are sick', () => {
    // "Everything is failing" must still mean "try them", not "try nothing".
    const h = createEndpointHealth<string>()
    for (const p of ALL) for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(p)
    expect(h.order(ALL, 1)).toEqual(['B', 'C', 'A'])
  })

  it('lifts the demotion after the cooldown', () => {
    // Endpoints recover; a demotion that never lapsed would shrink the pool
    // permanently on the strength of one bad minute.
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, now: () => t })
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a)
    expect(h.order(ALL, 0)).toEqual(['B', 'C', 'A'])
    t += 10_001
    expect(h.order(ALL, 0)).toEqual(['A', 'B', 'C'])
  })

  it('a single success clears the streak immediately', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a)
    expect(h.demoted(ALL)).toEqual(['A'])
    h.recordSuccess(P.a)
    expect(h.demoted(ALL)).toEqual([])
    expect(h.order(ALL, 0)).toEqual(['A', 'B', 'C'])
  })

  it('tracks endpoints separately by identity', () => {
    const h = createEndpointHealth<string>()
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a)
    expect(h.demoted(ALL)).toEqual(['A'])
  })

  it('handles an empty pool and a single endpoint', () => {
    const h = createEndpointHealth<string>()
    expect(h.order([], 0)).toEqual([])
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a)
    // The only endpoint we have is still the one we must use.
    expect(h.order([P.a], 0)).toEqual(['A'])
  })
})
