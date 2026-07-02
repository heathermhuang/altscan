import { MetadataRoute } from 'next'
import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { chainConfig } from '@/lib/chain'

// Re-render hourly. Without this the sitemap bakes at build time and serves
// stale entries until the next deploy (it was ~2M blocks behind tip).
export const revalidate = 3600

// Block detail URLs are deliberately NOT sitemapped: retention prunes blocks
// after days, so those entries rot into thin RPC-fallback pages. Token pages
// are the durable long-tail surface. 5,000 keeps this a single sitemap file
// (limit 50k) and the query a cheap index-only top-N (tokens_holder_count_idx).
const SITEMAP_TOKENS = 5000

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const BASE = `https://${chainConfig.domain}`
  const now = new Date()

  // lastModified only on pages whose content genuinely changes every crawl —
  // an always-"now" lastmod on everything teaches crawlers to ignore it.
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: 'always', priority: 1, lastModified: now },
    { url: `${BASE}/blocks`, changeFrequency: 'always', priority: 0.9, lastModified: now },
    { url: `${BASE}/txs`, changeFrequency: 'always', priority: 0.9, lastModified: now },
    { url: `${BASE}/token`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${BASE}/dex`, changeFrequency: 'always', priority: 0.7 },
    { url: `${BASE}/whales`, changeFrequency: 'always', priority: 0.7 },
    { url: `${BASE}/charts`, changeFrequency: 'daily', priority: 0.6 },
    { url: `${BASE}/gas`, changeFrequency: 'always', priority: 0.6, lastModified: now },
    ...(chainConfig.features.hasValidators ? [{ url: `${BASE}/validators`, changeFrequency: 'hourly' as const, priority: 0.5 }] : []),
    ...(chainConfig.features.hasStaking ? [{ url: `${BASE}/staking`, changeFrequency: 'hourly' as const, priority: 0.5 }] : []),
    { url: `${BASE}/developer`, changeFrequency: 'weekly', priority: 0.5 },
    { url: `${BASE}/api-docs`, changeFrequency: 'weekly', priority: 0.5 },
    { url: `${BASE}/about`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE}/search`, changeFrequency: 'monthly', priority: 0.3 },
  ]

  try {
    const topTokens = await db
      .select({ address: schema.tokens.address })
      .from(schema.tokens)
      .orderBy(desc(schema.tokens.holderCount))
      .limit(SITEMAP_TOKENS)

    // No lastModified: tokens has no timestamp column — don't fabricate one.
    const tokenRoutes: MetadataRoute.Sitemap = topTokens.map(t => ({
      url: `${BASE}/token/${t.address}`,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    }))

    return [...staticRoutes, ...tokenRoutes]
  } catch {
    return staticRoutes
  }
}
