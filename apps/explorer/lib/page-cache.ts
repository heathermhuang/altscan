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
 * Run `query` through the data cache.
 *
 * A rejection is NOT cached — Next only stores a resolved value — which is the
 * behaviour we want: caching a failed query would pin an outage in place for
 * the whole revalidate window and render it indistinguishable from an empty
 * chain. Callers must therefore let failures reach them rather than resolving
 * to `[]` inside the query.
 */
export function cachedPageQuery<T>(
  name: string,
  parts: readonly (string | number)[],
  revalidateSeconds: number,
  query: () => Promise<T>,
): Promise<T> {
  return unstable_cache(query, buildCacheKey(name, parts), {
    revalidate: revalidateSeconds,
    tags: [`${name}:${chainConfig.key}`],
  })()
}
