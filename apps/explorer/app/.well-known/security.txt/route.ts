import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

const SECURITY_TXT = `Contact: mailto:bnbscan@mdt.io
Contact: https://github.com/nicemdt/bnbscan/security/advisories
Expires: 2027-12-31T23:59:59.000Z
Preferred-Languages: en
Canonical: https://${chainConfig.domain}/.well-known/security.txt
Policy: https://github.com/nicemdt/bnbscan/security/policy

# ${chainConfig.brandDomain} — ${chainConfig.tagline}
# Maintained by Measurable Data Token (MDT)
# https://www.coingecko.com/en/coins/measurable-data-token
`

export async function GET() {
  return new NextResponse(SECURITY_TXT, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
