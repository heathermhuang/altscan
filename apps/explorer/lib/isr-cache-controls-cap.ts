/**
 * Bounds Next's per-path ISR cache-control map.
 *
 * Every on-demand ISR render (`/tx/<hash>`, `/blocks/<n>`: empty
 * generateStaticParams) adds an entry to `SharedCacheControls.cacheControls`, a
 * static Map that Next never evicts — not in 15.5.28, latest or canary. Bots
 * crawl ~7k distinct ISR paths an hour on ETH, at ~330 B of heap each, so the
 * web service's memory climbed linearly between deploys (413 -> 881 MB in 40h
 * after the 2026-10-24 deploy).
 *
 * Dropping an entry is safe. A cached page with no entry falls back to Next's
 * 1-second default (IncrementalCache.calculateRevalidate), so it is served STALE
 * once, re-rendered in the background, and its entry re-added. The pages
 * themselves live in a separate 50 MB LRU that turns over far faster than this
 * cap, so trimmed entries almost always belong to pages that are already gone.
 * `isr-cache-controls-cap.test.ts` pins both halves of that contract.
 */

/** The live Map. `.external` modules stay out of the webpack bundles, so this is the server's own instance. */
export async function loadIsrCacheControls(): Promise<Map<string, unknown>> {
  // A literal path: webpack must see it to leave it external.
  const { SharedCacheControls } = await import('next/dist/server/lib/incremental-cache/shared-cache-controls.external.js')
  const map = (SharedCacheControls as unknown as { cacheControls?: unknown }).cacheControls
  if (!(map instanceof Map)) throw new Error(`SharedCacheControls.cacheControls is ${typeof map}, not a Map`)
  return map
}

/** Deletes the oldest-inserted entries until at most `max` remain. Returns how many it deleted. */
export function trimOldest(map: Map<unknown, unknown>, max: number): number {
  const excess = map.size - max
  if (excess <= 0) return 0
  let left = excess
  for (const key of map.keys()) {
    if (left-- <= 0) break
    map.delete(key)
  }
  return excess
}
