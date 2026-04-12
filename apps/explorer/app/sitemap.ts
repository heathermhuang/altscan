import { MetadataRoute } from 'next'
import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { chainConfig } from '@/lib/chain'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const BASE = `https://${chainConfig.domain}`
  const now = new Date()

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: 'always', priority: 1, lastModified: now },
    { url: `${BASE}/blocks`, changeFrequency: 'always', priority: 0.9, lastModified: now },
    { url: `${BASE}/txs`, changeFrequency: 'always', priority: 0.9, lastModified: now },
    { url: `${BASE}/token`, changeFrequency: 'hourly', priority: 0.8, lastModified: now },
    { url: `${BASE}/dex`, changeFrequency: 'always', priority: 0.7, lastModified: now },
    { url: `${BASE}/whales`, changeFrequency: 'always', priority: 0.7, lastModified: now },
    { url: `${BASE}/charts`, changeFrequency: 'daily', priority: 0.6, lastModified: now },
    { url: `${BASE}/gas`, changeFrequency: 'always', priority: 0.6, lastModified: now },
    ...(chainConfig.features.hasValidators ? [{ url: `${BASE}/validators`, changeFrequency: 'hourly' as const, priority: 0.5, lastModified: now }] : []),
    ...(chainConfig.features.hasStaking ? [{ url: `${BASE}/staking`, changeFrequency: 'hourly' as const, priority: 0.5, lastModified: now }] : []),
    { url: `${BASE}/developer`, changeFrequency: 'weekly', priority: 0.5, lastModified: now },
    { url: `${BASE}/api-docs`, changeFrequency: 'weekly', priority: 0.5, lastModified: now },
    { url: `${BASE}/about`, changeFrequency: 'monthly', priority: 0.4, lastModified: now },
    { url: `${BASE}/search`, changeFrequency: 'monthly', priority: 0.3, lastModified: now },
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
      lastModified: now,
    }))

    const tokenRoutes: MetadataRoute.Sitemap = recentTokens.map(t => ({
      url: `${BASE}/token/${t.address}`,
      changeFrequency: 'hourly' as const,
      priority: 0.6,
      lastModified: now,
    }))

    return [...staticRoutes, ...blockRoutes, ...tokenRoutes]
  } catch {
    return staticRoutes
  }
}
