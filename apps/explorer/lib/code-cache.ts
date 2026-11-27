import type { CodeClass } from './contract-status'
import { createTtlCache } from './ttl-cache'

/** Only settled verdicts are cacheable. 'malformed' is a failure, not an answer. */
type CacheableClass = Extract<CodeClass, 'none' | 'code'>

interface CodeClassCache {
  get(address: string): CacheableClass | undefined
  set(address: string, cls: CacheableClass): void
  size(): number
}

/**
 * Bounded LRU with class-dependent TTLs, for eth_getCode verdicts.
 *
 * The address page reads searchParams and headers(), so it is dynamically
 * rendered on every request — its `revalidate = 300` never applied. Deriving
 * contract-ness from getCode therefore costs one RPC call per hit.
 *
 * ⚠ Be honest about what this does and does not buy. A crawler sweeping many
 * DISTINCT addresses MISSES every time, so this does not blunt that traffic at
 * all. What it removes is the repeat cost on popular addresses — the tokens and
 * exchange wallets people actually load over and over, and the API route hitting
 * the same address the page just rendered.
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
  name?: string
}): CodeClassCache {
  const { codeTtlMs, noneTtlMs } = opts
  // LRU, not FIFO (createTtlCache), so a popular address survives a sweep past it; an
  // expired entry is purged on read rather than merely hidden, so it cannot hold a slot.
  const store = createTtlCache<CacheableClass>({ max: opts.max, ttlMs: codeTtlMs, clock: opts.clock, name: opts.name })
  const key = (a: string) => a.trim().toLowerCase()

  return {
    get: (address) => store.get(key(address)),
    set(address, cls) {
      if (cls !== 'none' && cls !== 'code') return
      store.set(key(address), cls, cls === 'code' ? codeTtlMs : noneTtlMs)
    },
    size: () => store.size,
  }
}

// Process-wide instance. ~5k entries of a short string is well under a megabyte,
// and Render runs a long-lived Node server so this survives between requests.
export const codeClassCache = makeCodeClassCache({
  name: 'code-class',
  max: 5000,
  // 1h, not a day. A reorg that orphans a deployment would otherwise leave a
  // wrong 'code' verdict pinned for 24h, and the extra hit rate beyond an hour is
  // negligible: repeat views of one address cluster far tighter than that.
  codeTtlMs: 60 * 60 * 1000,
  noneTtlMs: 5 * 60 * 1000,         // an EOA may be deployed to at any moment
})
