import { describe, it, expect } from 'vitest'
import {
  createEndpointHealth,
  DEFAULT_DEMOTE_AFTER,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_COOLDOWN_MS,
} from './endpoint-health'

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

  /**
   * MEASURED IN PROD 2026-08-17, BNB. A flat cooldown re-probes a PERMANENTLY
   * broken endpoint with real indexing work once per cooldown, forever.
   *
   * bsc.publicnode.com cannot serve archive requests at all, and the indexer only
   * makes archive requests while behind — so it can never recover on its own. The
   * flat 60s cooldown lapsed it back into full round-robin every minute, ~1/3 of
   * concurrent blocks started on it, each paid RPC_FETCH_TIMEOUT_MS=8s, and the
   * contiguous-prefix advance in index.ts froze `lastIndexed` for the whole batch.
   * Result: a ~50s slow segment every ~77s — a cycle governed by nothing but this
   * constant — 62.7% of wall clock at 0.69 blk/s against a 2.226 blk/s chain.
   * Segments where it stayed demoted ran at 4.17 blk/s, so the pool was never the
   * problem; the re-probe was.
   *
   * Backoff must therefore scale with the failure streak, so an endpoint that
   * never recovers costs a bounded, shrinking share of throughput.
   */
  it('escalates the cooldown with the failure streak', () => {
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, maxCooldownMs: 1_000_000, now: () => t })
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    // At exactly the threshold the cooldown is still the base — one bad blip must
    // not earn a long exile.
    t += 10_001
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])

    // One more failure past the threshold doubles it: still demoted at base+1ms,
    // released only after 2x.
    h.recordFailure(P.a, 'block')
    t += 10_001
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
    t += 10_000
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])

    // Two past the threshold quadruples it.
    h.recordFailure(P.a, 'block')
    t += 30_001
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
    t += 10_000
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
  })

  /**
   * Invariant 2 from the module docstring — "demotion expires" — must survive the
   * backoff. Without a cap, 2**streak grows past any clock and the endpoint is
   * exiled for good, which is the failure mode the cap exists to prevent.
   */
  it('caps the escalating cooldown so a demotion always expires', () => {
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, maxCooldownMs: 40_000, now: () => t })
    for (let i = 0; i < 500; i++) h.recordFailure(P.a, 'block')
    t += 40_001
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
  })

  it('a huge failure streak cannot produce a non-finite cooldown', () => {
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 60_000, maxCooldownMs: 900_000, now: () => t })
    for (let i = 0; i < 5_000; i++) h.recordFailure(P.a, 'block')
    // 2 ** 5000 is Infinity; an unclamped exponent would make the endpoint
    // permanently demoted no matter how far the clock advances.
    t += 900_001
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
  })

  it('a success after a long streak restores the endpoint immediately', () => {
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, maxCooldownMs: 1_000_000, now: () => t })
    for (let i = 0; i < 40; i++) h.recordFailure(P.a, 'block')
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
    // Recovery must not be gated on the escalated cooldown: the streak is what
    // earned the backoff, and one success clears the streak.
    h.recordSuccess(P.a, 'block')
    expect(h.order(ALL, 0, 'block')).toEqual(['A', 'B', 'C'])
  })

  it('defaults keep the base cooldown below the cap', () => {
    expect(DEFAULT_COOLDOWN_MS).toBeLessThan(DEFAULT_MAX_COOLDOWN_MS)
  })

  it('a maxCooldownMs below the base never shortens the base cooldown', () => {
    // Misconfiguration must not silently disable demotion.
    let t = 1_000
    const h = createEndpointHealth<string>({ cooldownMs: 10_000, maxCooldownMs: 1_000, now: () => t })
    for (let i = 0; i < DEFAULT_DEMOTE_AFTER; i++) h.recordFailure(P.a, 'block')
    t += 9_999
    expect(h.order(ALL, 0, 'block')).toEqual(['B', 'C', 'A'])
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
