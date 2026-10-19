import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'
import { OPENAPI_MEDIA_TYPE, buildOpenApi } from '@/lib/openapi'

// OpenAPI 3.1 description of the public REST API (lib/openapi.ts), linked from the RFC 9727
// catalog and the homepage Link header as rel="service-desc".

export const revalidate = 3600

export async function GET() {
  return new NextResponse(JSON.stringify(buildOpenApi(chainConfig)), {
    headers: {
      'Content-Type': OPENAPI_MEDIA_TYPE,
      'Cache-Control': 'public, max-age=3600',
      // Browser-based OpenAPI tools load the spec cross-origin.
      'Access-Control-Allow-Origin': '*',
    },
  })
}
