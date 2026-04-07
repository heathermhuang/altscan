/**
 * Cache registry — central place to query all in-memory cache sizes.
 * Used by the health endpoint and memory monitor to detect leaks.
 */

type CacheSizeGetter = () => number

const registry = new Map<string, CacheSizeGetter>()

export function registerCache(name: string, getSizeFn: CacheSizeGetter): void {
  registry.set(name, getSizeFn)
}

export function getCacheSizes(): Record<string, number> {
  const sizes: Record<string, number> = {}
  for (const [name, fn] of registry) {
    sizes[name] = fn()
  }
  return sizes
}

export function getTotalCacheEntries(): number {
  let total = 0
  for (const fn of registry.values()) {
    total += fn()
  }
  return total
}
