import { MetadataRoute } from 'next'
import { chainConfig } from '@/lib/chain'

export default function robots(): MetadataRoute.Robots {
  const BASE = `https://${chainConfig.domain}`
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Block address pages (heavy DB + Moralis lookups — protect infra from bots)
      // Block API routes (not for crawlers)
      disallow: ['/address/', '/api/'],
    },
    sitemap: `${BASE}/sitemap.xml`,
  }
}
