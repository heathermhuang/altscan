import { NextResponse, type NextRequest } from 'next/server'
import { isBinanceRestrictedCountry } from '@/lib/binance-referral'
import { getSetting } from '@/lib/settings'
import { resolveAds } from '@/lib/settings-defaults'

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

/**
 * Ad config for the client ad components: geo eligibility (as before) plus
 * settings-driven fields — referral-code override and disabled placements.
 */
export async function GET(request: NextRequest) {
  const country = getCountry(request)
  const eligible = !isBinanceRestrictedCountry(country)
  const ads = resolveAds(await getSetting('ads'))

  return NextResponse.json(
    { eligible, refCode: ads.refCode, disabled: ads.disabled },
    {
      headers: {
        // Was 3600 for the plain boolean; settings changes should land
        // reasonably fast, so cap client caching at 5 min (matches the
        // component's sessionStorage TTL).
        'Cache-Control': 'private, max-age=300',
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
