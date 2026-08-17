/**
 * Health-aware endpoint ordering.
 *
 * Failover already stops one sick endpoint from aborting a batch, but it still
 * pays that endpoint's full cost on every block that happens to start on it:
 * with 3 endpoints and a round-robin start, ~1/3 of blocks begin by waiting out
 * an 8s timeout before failing over. That is exactly the tax
 * `bsc.publicnode.com` charges — it serves recent blocks fine but 403s archive
 * requests, which the indexer only makes once it is ALREADY behind, so the tax
 * lands precisely when throughput matters most.
 *
 * This demotes an endpoint that keeps failing to LAST place, so the common path
 * stops starting there.
 *
 * Two properties this must never break:
 *
 *  1. **No endpoint is ever dropped.** A demoted endpoint is a last resort, not
 *     an exile — the order always contains every provider exactly once. If every
 *     endpoint is sick, the order degrades to plain round-robin rather than to an
 *     empty list, because "all of them are failing" must still mean "try them".
 *
 *  2. **Demotion expires.** Endpoints recover (rate limits reset, archive access
 *     is restored). A demotion that never lifted would permanently shrink the
 *     pool on the strength of one bad minute, so it lapses after a cooldown and
 *     the endpoint gets a probationary turn in normal rotation.
 *
 * ...but the probationary turn is not free, and a FLAT cooldown charges for it
 * at a fixed rate forever. Measured on BNB 2026-08-17: bsc.publicnode.com cannot
 * serve archive requests at all, and the indexer only issues archive requests
 * while it is behind, so that endpoint could never recover on its own. The flat
 * 60s cooldown lapsed it into full rotation once a minute; ~1/3 of concurrent
 * blocks started on it, each burned RPC_FETCH_TIMEOUT_MS=8s, and because
 * index.ts advances `lastIndexed` only through the contiguous DONE prefix, one
 * stuck block froze the whole 40-block batch. The result was a ~50s slow segment
 * every ~77s — a period set by nothing but this constant — leaving 62.7% of wall
 * clock running at 0.69 blk/s against a 2.226 blk/s chain, i.e. a permanent
 * throughput deficit that grew the lag monotonically until MAX_LAG_BLOCKS fired
 * and abandoned ~4,900 blocks at a time. Segments where the endpoint stayed
 * demoted ran at 4.17 blk/s, so the pool was always fast enough; the re-probe
 * was the whole cost.
 *
 * So the cooldown ESCALATES with the failure streak (doubling, capped). A
 * one-off blip still costs only the base cooldown, while an endpoint that never
 * recovers converges on the cap and its tax decays toward zero. Invariant 2 is
 * preserved by the cap: every demotion still expires. Recovery is not gated on
 * the escalated wait — `recordSuccess` clears the streak outright, so the first
 * request an endpoint serves restores it to full rotation immediately.
 */

/** Consecutive failures before an endpoint is demoted to last resort. */
export const DEFAULT_DEMOTE_AFTER = 3

/**
 * Base demotion length, charged at exactly DEFAULT_DEMOTE_AFTER failures. Each
 * additional consecutive failure doubles it, up to DEFAULT_MAX_COOLDOWN_MS.
 */
export const DEFAULT_COOLDOWN_MS = 60_000

/**
 * Ceiling on the escalated cooldown. Bounds how long a recovered endpoint can
 * stay demoted after a long streak — the price of invariant 2. With the defaults
 * a hopeless endpoint reaches this after 7 consecutive failures.
 */
export const DEFAULT_MAX_COOLDOWN_MS = 900_000

/**
 * Operation class. Health is tracked PER KIND, because endpoints fail per
 * capability rather than wholesale.
 *
 * bsc.publicnode.com is the motivating case and it breaks a single shared
 * tracker outright: it answers `getBlockNumber()` perfectly while 403ing archive
 * block fetches. With one pooled streak, every successful tip read wipes the
 * archive failures, the demotion never sticks, and the feature silently does
 * nothing for the exact endpoint it was built for. (codex P2, round 3.)
 *
 * Per-kind also gives the RIGHT answer rather than merely a working one: such an
 * endpoint stays in normal rotation for the reads it serves correctly and is
 * demoted only for the fetches it cannot.
 */
export type HealthKind = 'read' | 'block'

export type EndpointHealth<P> = {
  /** Attempt order for one call: healthy round-robin first, demoted last. */
  order(providers: readonly P[], startIdx: number, kind: HealthKind): P[]
  recordSuccess(provider: P, kind: HealthKind): void
  recordFailure(provider: P, kind: HealthKind): void
  /** Demoted endpoints for a kind, for logging/inspection. */
  demoted(providers: readonly P[], kind: HealthKind): P[]
}

type State = { consecutiveFailures: number; lastFailureAt: number; failedWaves: number }

export function createEndpointHealth<P>(opts?: {
  demoteAfter?: number
  cooldownMs?: number
  maxCooldownMs?: number
  now?: () => number
}): EndpointHealth<P> {
  const demoteAfter = opts?.demoteAfter ?? DEFAULT_DEMOTE_AFTER
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  // Floored AT the base: a cap below it would SHORTEN the base cooldown, turning
  // a misconfiguration into "demotion barely applies" — the opposite of what a
  // ceiling is for.
  const maxCooldownMs = Math.max(opts?.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS, cooldownMs)
  const now = opts?.now ?? (() => Date.now())

  /**
   * Demotion length after `failedWaves` blown probations: the base, doubled per
   * WAVE, capped.
   *
   * A high wave count overflows the shift — `2 ** 2000` is Infinity — and that
   * is SAFE here only because the cap is applied with Math.min, which returns
   * the cap against Infinity. The cap is therefore load-bearing for invariant 2
   * at extreme counts, not merely a tuning knob, and `a huge wave count cannot
   * produce a non-finite cooldown` pins that. (An explicit exponent clamp was
   * tried here first; mutation testing showed it could not fail, so it was
   * removed rather than left as a guard nothing verifies.)
   */
  const cooldownFor = (failedWaves: number): number =>
    Math.min(cooldownMs * 2 ** failedWaves, maxCooldownMs)
  // Keyed by provider IDENTITY. Two differently-keyed endpoints on the same host
  // redact to the same label, so a label-keyed map would merge their health and
  // let one endpoint's failures demote the other. (Same trap the failover logger
  // already documents.)
  const byKind = new Map<HealthKind, Map<P, State>>()
  const stateFor = (kind: HealthKind): Map<P, State> => {
    let m = byKind.get(kind)
    if (!m) { m = new Map<P, State>(); byKind.set(kind, m) }
    return m
  }

  const isDemoted = (p: P, kind: HealthKind): boolean => {
    const s = stateFor(kind).get(p)
    if (!s || s.consecutiveFailures < demoteAfter) return false
    // Lapsed demotions return to normal rotation — endpoints do recover. The
    // wait scales with the number of blown probations so a hopeless endpoint is
    // re-probed exponentially less often (see cooldownFor).
    return now() - s.lastFailureAt < cooldownFor(s.failedWaves)
  }

  return {
    recordSuccess(provider, kind) {
      // A single success clears the streak for THIS kind only. Health here is
      // about "is this endpoint currently serving this class of request", not a
      // long-run error rate — and emphatically not a claim about other classes.
      stateFor(kind).delete(provider)
    },

    recordFailure(provider, kind) {
      const m = stateFor(kind)
      const s = m.get(provider) ?? { consecutiveFailures: 0, lastFailureAt: 0, failedWaves: 0 }
      const at = now()
      // Escalate per PROBATION WAVE, not per failure. index.ts runs
      // INDEX_CONCURRENCY block workers, so the instant a demotion lapses
      // several of them select this endpoint together and all fail before any
      // one records a result — a single wave arrives as 3-8 failures. Charging
      // a doubling each would turn one bad minute into an 8-minute exile for an
      // endpoint that may have recovered immediately, shrinking the pool during
      // a TRANSIENT outage. That is the opposite of the goal, which is to stop
      // paying for a PERMANENTLY broken one. (codex P2.)
      //
      // A wave counts only when the failure lands after the previous demotion
      // had already expired — i.e. "it got another turn and blew it". Failures
      // arriving while still demoted, or before the endpoint has been demoted at
      // all, belong to a wave already counted.
      if (s.consecutiveFailures >= demoteAfter && at - s.lastFailureAt >= cooldownFor(s.failedWaves)) {
        s.failedWaves += 1
      }
      s.consecutiveFailures += 1
      s.lastFailureAt = at
      m.set(provider, s)
    },

    demoted(providers, kind) {
      return providers.filter(p => isDemoted(p, kind))
    },

    order(providers, startIdx, kind) {
      if (providers.length === 0) return []
      const start = ((startIdx % providers.length) + providers.length) % providers.length
      // Round-robin sequence first, so healthy endpoints keep the existing spread
      // that distributes per-IP rate-limit pressure.
      const rotated: P[] = []
      for (let i = 0; i < providers.length; i++) rotated.push(providers[(start + i) % providers.length])

      // Partition from ONE snapshot. Evaluating isDemoted() separately per branch
      // re-reads the clock, so an endpoint whose cooldown expires between the two
      // passes is judged demoted by the first and healthy by the second — landing
      // in NEITHER list and silently vanishing from the pool. That breaks the
      // never-drop invariant precisely at the moment an endpoint recovers, and a
      // fixed-clock test cannot see it. (codex P2, round 3.)
      const demotedNow = new Set<P>()
      for (const p of rotated) if (isDemoted(p, kind)) demotedNow.add(p)

      const healthy = rotated.filter(p => !demotedNow.has(p))
      // Every provider appears exactly once: if all are demoted, `healthy` is
      // empty and this returns the plain rotation rather than nothing.
      if (healthy.length === 0) return rotated
      return [...healthy, ...rotated.filter(p => demotedNow.has(p))]
    },
  }
}
