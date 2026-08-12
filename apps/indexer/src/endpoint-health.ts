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
 */

/** Consecutive failures before an endpoint is demoted to last resort. */
export const DEFAULT_DEMOTE_AFTER = 3

/** How long a demotion lasts before the endpoint is retried in normal order. */
export const DEFAULT_COOLDOWN_MS = 60_000

export type EndpointHealth<P> = {
  /** Attempt order for one call: healthy round-robin first, demoted last. */
  order(providers: readonly P[], startIdx: number): P[]
  recordSuccess(provider: P): void
  recordFailure(provider: P): void
  /** Demoted endpoints, for logging/inspection. */
  demoted(providers: readonly P[]): P[]
}

type State = { consecutiveFailures: number; lastFailureAt: number }

export function createEndpointHealth<P>(opts?: {
  demoteAfter?: number
  cooldownMs?: number
  now?: () => number
}): EndpointHealth<P> {
  const demoteAfter = opts?.demoteAfter ?? DEFAULT_DEMOTE_AFTER
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const now = opts?.now ?? (() => Date.now())
  // Keyed by provider IDENTITY. Two differently-keyed endpoints on the same host
  // redact to the same label, so a label-keyed map would merge their health and
  // let one endpoint's failures demote the other. (Same trap the failover logger
  // already documents.)
  const state = new Map<P, State>()

  const isDemoted = (p: P): boolean => {
    const s = state.get(p)
    if (!s || s.consecutiveFailures < demoteAfter) return false
    // Lapsed demotions return to normal rotation — endpoints do recover.
    return now() - s.lastFailureAt < cooldownMs
  }

  return {
    recordSuccess(provider) {
      // A single success clears the streak outright. Health here is about "is
      // this endpoint currently answering", not a long-run error rate.
      state.delete(provider)
    },

    recordFailure(provider) {
      const s = state.get(provider) ?? { consecutiveFailures: 0, lastFailureAt: 0 }
      s.consecutiveFailures += 1
      s.lastFailureAt = now()
      state.set(provider, s)
    },

    demoted(providers) {
      return providers.filter(isDemoted)
    },

    order(providers, startIdx) {
      if (providers.length === 0) return []
      const start = ((startIdx % providers.length) + providers.length) % providers.length
      // Round-robin sequence first, so healthy endpoints keep the existing spread
      // that distributes per-IP rate-limit pressure.
      const rotated: P[] = []
      for (let i = 0; i < providers.length; i++) rotated.push(providers[(start + i) % providers.length])

      const healthy = rotated.filter(p => !isDemoted(p))
      // Every provider appears exactly once: if all are demoted, `healthy` is
      // empty and this returns the plain rotation rather than nothing.
      if (healthy.length === 0) return rotated
      return [...healthy, ...rotated.filter(isDemoted)]
    },
  }
}
