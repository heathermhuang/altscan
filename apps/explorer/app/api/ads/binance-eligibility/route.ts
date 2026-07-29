import { NextResponse, type NextRequest } from 'next/server'
import { isBinanceRestrictedCountry } from '@/lib/binance-referral'
import { getSetting } from '@/lib/settings'
import { buildAdConfig } from '@/lib/settings-defaults'

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

/** Public bucket that serves house-creative images. Overridable per deployment;
 *  the default is the CF R2 custom domain. buildAdConfig re-checks that this is
 *  an https origin before it builds any URL from it. */
const CREATIVES_BASE_URL = process.env.CREATIVES_BASE_URL ?? 'https://creatives.altscan.io'

/** Object-key prefix this deployment owns, e.g. "altscan/bnb/". The explorer has
 *  no tenant table, so the value is supplied per service. Unset ⇒ no ownership
 *  check (behaviour before this feature); set it on both web services. */
const CREATIVES_KEY_PREFIX = process.env.CREATIVES_KEY_PREFIX ?? null

/**
 * Ad config for the client ad components: geo eligibility (as before) plus
 * settings-driven fields — referral code, disabled placements, and the
 * per-placement candidate list the client rolls against.
 */
export async function GET(request: NextRequest) {
  const country = getCountry(request)
  const config = buildAdConfig(await getSetting('ads'), {
    binanceRestricted: isBinanceRestrictedCountry(country),
    creativesBaseUrl: CREATIVES_BASE_URL,
    creativesKeyPrefix: CREATIVES_KEY_PREFIX,
  })

  return NextResponse.json(config, {
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
  })
}
