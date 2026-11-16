import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// Personal Agent Protocol (Poppy) discovery, website-only form
// (https://personalagentprotocol.org/docs/spec#3-discovery). It declares the public
// website and nothing else: no Poppy sign-in, Session header handling or conversation
// endpoint exists here, and an agent/API declaration would have to bind an issuer that
// implements them. `organization.domain` must be the host that serves the document.
// Version 0.1 is the one isitagentready.com validates; before 1.0 a version is only
// compatible with the same minor, so a 1.0 agent ignores this document.

export const revalidate = 3600

export async function GET() {
  return NextResponse.json(
    {
      protocol_version: '0.1',
      organization: { name: chainConfig.brandName, domain: chainConfig.domain },
      web: {},
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  )
}
