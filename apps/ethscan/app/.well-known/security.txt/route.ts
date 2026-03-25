import { NextResponse } from 'next/server'

const SECURITY_TXT = `Contact: mailto:ethscan@mdt.io
Contact: https://github.com/heathermhuang/bnbscan/security/advisories
Expires: 2027-12-31T23:59:59.000Z
Preferred-Languages: en
Canonical: https://ethscan.io/.well-known/security.txt
Policy: https://github.com/heathermhuang/bnbscan/security/policy

# EthScan.io — Ethereum Block Explorer
# Maintained by Measurable Data Token (MDT)
# https://www.coingecko.com/en/coins/measurable-data-token
# This is a LEGITIMATE project, NOT affiliated with etherscan.io
`

export async function GET() {
  return new NextResponse(SECURITY_TXT, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
