import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'
import { API_SURFACE } from '@/lib/api-surface'

// RFC 9727 API Catalog — advertises this site's public REST API so agents can
// discover it without scraping. One linkset entry per public resource family.
// No machine-readable OpenAPI spec exists yet, so service-desc is omitted and
// service-doc points at the human-readable /api-docs page.
export async function GET() {
  const BASE = `https://${chainConfig.domain}`
  const docs = `${BASE}/api-docs`
  const status = `${BASE}/api/health`

  const linkset = {
    linkset: API_SURFACE.filter(e => e.catalogAnchor).map(e => ({
      anchor: `${BASE}${e.path}`,
      'service-doc': [{ href: docs, type: 'text/html' }],
      ...(e.path === '/api/v1/stats'
        ? { status: [{ href: status, type: 'application/json' }] }
        : {}),
    })),
  }

  return NextResponse.json(linkset, {
    headers: {
      'Content-Type': 'application/linkset+json',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
