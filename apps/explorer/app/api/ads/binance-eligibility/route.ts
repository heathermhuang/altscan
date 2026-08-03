import { NextResponse, type NextRequest } from 'next/server'
import { isBinanceRestrictedCountry } from '@/lib/binance-referral'
import { chainConfig } from '@/lib/chain'
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

/**
 * Object-key prefix this deployment owns, e.g. "altscan/bnb/".
 *
 * DERIVED, not configured. An earlier revision read this from an env var and
 * treated "unset" as "skip the check" — a security control that silently
 * disables itself when someone forgets a deploy step is not a control. The
 * console mints keys as `<tenantId>/<explorerId>/…` and its D1 rows have
 * tenant `altscan` with explorer ids equal to the chain key, so the correct
 * prefix is computable here and the check is always on.
 *
 * The env var remains as an ESCAPE HATCH for a future tenant whose id is not
 * `altscan`, but an empty/whitespace value is ignored rather than treated as
 * "disabled" — there is deliberately no way to turn the check off by config.
 */
const CREATIVES_KEY_PREFIX =
  process.env.CREATIVES_KEY_PREFIX?.trim() || `altscan/${chainConfig.key}/`

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
