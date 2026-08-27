/**
 * Data-cache boundary for the list pages that read `searchParams`.
 *
 * `/txs`, `/blocks`, `/dex` and `/whales` all declare `export const revalidate`,
 * and none of it applied: reading `searchParams` opts the ROUTE into dynamic
 * rendering, so every request re-rendered AND re-queried, and responses came
 * back `no-store` (verified via `x-nextjs-cache`).
 *
 * The page stays dynamic — that is what `searchParams` means, and AGENTS.md
 * forbids the alternatives. What this removes is the database round trip on
 * every request, which on `/dex` included a `GROUP BY` over all of `dex_trades`.
 */
import { unstable_cache } from 'next/cache'
import { chainConfig } from '@/lib/chain'

/**
 * Build the cache key for a page query.
 *
 * Two properties are load-bearing and both are pinned by tests:
 *
 *   - the chain is in the key. Both chains run the same image against different
 *     databases (`config.dbEnvVar`), so an unscoped key lets whichever service
 *     warmed the entry first serve the other chain's rows.
 *   - every input the query varies on is in the key. Miss the page number and
 *     all pages collapse onto page 1's rows.
 */
export function buildCacheKey(
  name: string,
  parts: readonly (string | number)[],
): string[] {
  return [name, chainConfig.key, ...parts.map(String)]
}

/**
 * Build a cached reader ONCE, at module scope.
 *
 * The shape here is load-bearing, and the previous version got it wrong. It did:
 *
 *     return unstable_cache(query, buildCacheKey(name, parts), opts)()
 *
 * — constructing the wrapper inside the request, around a fresh closure that
 * captured the page number, and immediately invoking it. `unstable_cache`
 * derives part of its cache id from the callback itself, so a new closure per
 * request means a new id per request: every lookup missed, every request
 * re-queried, and nothing anywhere errored.
 *
 * Measured in production after #117 shipped: /blocks has a 60s TTL and its top
 * block advanced four times in ten seconds across two instances. Meanwhile /gas
 * — a static ISR route on the same incremental cache — returned
 * `x-nextjs-cache: HIT`, so the cache itself was healthy and only this was broken.
 *
 * The fix is the documented pattern: one stable function, created at module
 * scope, with the varying inputs passed as ARGUMENTS. Next includes the
 * arguments in the cache id, which is what makes per-page entries work without
 * a per-request closure.
 *
 * A rejection is still not cached — Next only stores a resolved value — so
 * callers must let failures propagate rather than resolving to `[]`, or an
 * outage gets pinned in place for the whole revalidate window.
 */
export function createPageCache<A extends unknown[], T>(
  name: string,
  revalidateSeconds: number,
  query: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return unstable_cache(query, buildCacheKey(name, []), {
    revalidate: revalidateSeconds,
    tags: [`${name}:${chainConfig.key}`],
  }) as (...args: A) => Promise<T>
}
