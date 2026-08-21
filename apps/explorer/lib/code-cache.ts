import type { CodeClass } from './contract-status'

/** Only settled verdicts are cacheable. 'malformed' is a failure, not an answer. */
export type CacheableClass = Extract<CodeClass, 'none' | 'code'>

export interface CodeClassCache {
  get(address: string): CacheableClass | undefined
  set(address: string, cls: CacheableClass): void
  size(): number
}

/**
 * Bounded LRU with class-dependent TTLs, for eth_getCode verdicts.
 *
 * The address page reads searchParams and headers(), so it is dynamically
 * rendered on every request — its `revalidate = 300` never applied. Deriving
 * contract-ness from getCode therefore costs one RPC call per hit, crawler
 * sweeps included. This bounds that.
 *
 * Stores the VERDICT, never the bytecode: runtime code runs to ~24KB a piece, so
 * caching it would trade an RPC bill for a memory one on a page whose enrichment
 * is already staged to limit peak memory.
 *
 * Two asymmetries are deliberate:
 *  - 'malformed' and RPC failures are never stored, so a transient outage cannot
 *    poison the cache with a verdict the page would then serve for hours.
 *  - 'none' expires far sooner than 'code'. A contract effectively never stops
 *    being one (post-Cancun SELFDESTRUCT only applies in the creating
 *    transaction), but an EOA becomes a contract whenever someone deploys to a
 *    counterfactual CREATE2 address — routine under account abstraction. A stale
 *    'code' is near-impossible; a stale 'none' must self-correct quickly.
 */
export function makeCodeClassCache(opts: {
  max: number
  codeTtlMs: number
  noneTtlMs: number
  clock?: () => number
}): CodeClassCache {
  const { max, codeTtlMs, noneTtlMs } = opts
  const clock = opts.clock ?? Date.now
  // Map iterates in insertion order, which is what makes the LRU a delete+set.
  const store = new Map<string, { cls: CacheableClass; expiresAt: number }>()
  const key = (a: string) => a.trim().toLowerCase()

  return {
    get(address) {
      const k = key(address)
      const hit = store.get(k)
      if (!hit) return undefined
      if (clock() >= hit.expiresAt) {
        // Purge rather than merely hide it, so dead entries cannot hold slots
        // against live ones under a sweep.
        store.delete(k)
        return undefined
      }
      store.delete(k)          // re-insert at the tail: this is LRU, not FIFO,
      store.set(k, hit)        // so a popular address survives a sweep past it.
      return hit.cls
    },
    set(address, cls) {
      if (cls !== 'none' && cls !== 'code') return
      const k = key(address)
      store.delete(k)
      store.set(k, { cls, expiresAt: clock() + (cls === 'code' ? codeTtlMs : noneTtlMs) })
      // `while`, not `if`: max can be lowered between calls.
      while (store.size > max) {
        const oldest = store.keys().next()
        if (oldest.done) break
        store.delete(oldest.value)
      }
    },
    size: () => store.size,
  }
}

// Process-wide instance. ~5k entries of a short string is well under a megabyte,
// and Render runs a long-lived Node server so this survives between requests.
export const codeClassCache = makeCodeClassCache({
  max: 5000,
  codeTtlMs: 24 * 60 * 60 * 1000,   // a contract stays a contract
  noneTtlMs: 5 * 60 * 1000,         // an EOA may be deployed to at any moment
})
