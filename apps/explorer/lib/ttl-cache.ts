import { registerCache } from './cache-registry'

/**
 * The explorer's one in-process cache: a bounded map whose entries expire.
 *
 * Every process-wide cache in this app holds the same shape of thing (a verdict, a name, a
 * miss) and has the same two obligations, which the hand-rolled copies kept forgetting:
 *  - memory is bounded by `max`, never by traffic. The web service runs a 1280 MB heap, and
 *    an unbounded per-key map was the named culprit of an OOM crash-loop.
 *  - its size is visible to /api/health through cache-registry, so a leak shows up as a
 *    number instead of a restart. Passing `name` registers it; only test instances omit it.
 *
 * Eviction is least-recently-used: a `get` hit moves the entry to the back, so a popular key
 * survives a crawler sweeping past it. Expiry is lazy (an expired entry is dropped when read,
 * or pushed out by newer ones); the bound holds either way, so no sweep timer is needed.
 *
 * `get` returns undefined for a miss, so a cached `null` (a remembered negative answer) is a
 * hit. Values must not be `undefined`.
 */
interface TtlCache<V> {
  get(key: string): V | undefined
  /** `ttlMs` overrides the cache's default for this entry. */
  set(key: string, value: Exclude<V, undefined>, ttlMs?: number): void
  delete(key: string): void
  clear(): void
  readonly size: number
}

export function createTtlCache<V>(opts: {
  max: number
  ttlMs: number
  /** Registers the cache's size with cache-registry under this name. */
  name?: string
  /** Injectable for tests. Read on every call, so fake timers apply. */
  clock?: () => number
}): TtlCache<V> {
  const { max, ttlMs } = opts
  const now = opts.clock ?? (() => Date.now())
  // Map iterates in insertion order, so delete+set moves a key to the back.
  const store = new Map<string, { value: V; expiresAt: number }>()

  const cache: TtlCache<V> = {
    get(key) {
      const hit = store.get(key)
      if (!hit) return undefined
      store.delete(key)
      if (now() >= hit.expiresAt) return undefined
      store.set(key, hit)
      return hit.value
    },
    set(key, value, entryTtlMs = ttlMs) {
      store.delete(key)
      store.set(key, { value, expiresAt: now() + entryTtlMs })
      while (store.size > max) {
        const oldest = store.keys().next()
        if (oldest.done) break
        store.delete(oldest.value)
      }
    },
    delete(key) { store.delete(key) },
    clear() { store.clear() },
    get size() { return store.size },
  }
  if (opts.name) registerCache(opts.name, () => store.size)
  return cache
}
