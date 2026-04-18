import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// RFC 9727 API Catalog — advertises this site's public REST API so agents can
// discover it without scraping. One linkset entry per public resource family.
// No machine-readable OpenAPI spec exists yet, so service-desc is omitted and
// service-doc points at the human-readable /api-docs page.
export async function GET() {
  const BASE = `https://${chainConfig.domain}`
  const docs = `${BASE}/api-docs`
  const status = `${BASE}/api/health`

  const linkset = {
    linkset: [
      {
        anchor: `${BASE}/api/v1/stats`,
        'service-doc': [{ href: docs, type: 'text/html' }],
        status: [{ href: status, type: 'application/json' }],
      },
      {
        anchor: `${BASE}/api/v1/blocks`,
        'service-doc': [{ href: docs, type: 'text/html' }],
      },
      {
        anchor: `${BASE}/api/v1/transactions`,
        'service-doc': [{ href: docs, type: 'text/html' }],
      },
      {
        anchor: `${BASE}/api/v1/addresses`,
        'service-doc': [{ href: docs, type: 'text/html' }],
      },
      {
        anchor: `${BASE}/api/v1/tokens`,
        'service-doc': [{ href: docs, type: 'text/html' }],
      },
      {
        anchor: `${BASE}/api/v1/contracts`,
        'service-doc': [{ href: docs, type: 'text/html' }],
      },
    ],
  }

  return NextResponse.json(linkset, {
    headers: {
      'Content-Type': 'application/linkset+json',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
