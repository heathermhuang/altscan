import { NextResponse, type NextRequest } from 'next/server'
import { isBinanceRestrictedCountry } from '@/lib/binance-referral'

export const dynamic = 'force-dynamic'

function getCountry(request: NextRequest): string | null {
  return (
    request.headers.get('cf-ipcountry') ||
    request.headers.get('x-vercel-ip-country') ||
    request.headers.get('cloudfront-viewer-country') ||
    request.headers.get('x-country-code') ||
    request.headers.get('x-appengine-country')
  )
}

export function GET(request: NextRequest) {
  const country = getCountry(request)
  const eligible = !isBinanceRestrictedCountry(country)

  return NextResponse.json(
    { eligible },
    {
      headers: {
        'Cache-Control': 'private, max-age=3600',
        Vary: [
          'CF-IPCountry',
          'X-Vercel-IP-Country',
          'CloudFront-Viewer-Country',
          'X-Country-Code',
          'X-AppEngine-Country',
        ].join(', '),
      },
    },
  )
}
