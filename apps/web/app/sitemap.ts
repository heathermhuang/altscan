import { MetadataRoute } from 'next'
import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const BASE = 'https://bnbscan.com'

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: 'always', priority: 1 },
    { url: `${BASE}/blocks`, changeFrequency: 'always', priority: 0.9 },
    { url: `${BASE}/txs`, changeFrequency: 'always', priority: 0.9 },
    { url: `${BASE}/token`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${BASE}/dex`, changeFrequency: 'always', priority: 0.7 },
    { url: `${BASE}/charts`, changeFrequency: 'daily', priority: 0.6 },
    { url: `${BASE}/gas`, changeFrequency: 'always', priority: 0.6 },
    { url: `${BASE}/validators`, changeFrequency: 'hourly', priority: 0.5 },
    { url: `${BASE}/api-docs`, changeFrequency: 'weekly', priority: 0.5 },
    { url: `${BASE}/whales`, changeFrequency: 'always', priority: 0.7 },
  ]

  try {
    const [recentBlocks, recentTokens] = await Promise.all([
      db.select({ number: schema.blocks.number }).from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(100),
      db.select({ address: schema.tokens.address }).from(schema.tokens).limit(200),
    ])

    const blockRoutes: MetadataRoute.Sitemap = recentBlocks.map(b => ({
      url: `${BASE}/blocks/${b.number}`,
      changeFrequency: 'never' as const,
      priority: 0.4,
    }))

    const tokenRoutes: MetadataRoute.Sitemap = recentTokens.map(t => ({
      url: `${BASE}/token/${t.address}`,
      changeFrequency: 'hourly' as const,
      priority: 0.6,
    }))

    return [...staticRoutes, ...blockRoutes, ...tokenRoutes]
  } catch {
    return staticRoutes
  }
}
