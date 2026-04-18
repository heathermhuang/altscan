import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { chainConfig } from '@/lib/chain'
import { skillBody } from '../api-usage/SKILL.md/route'

// Agent Skills Discovery (v0.2.0) — https://agentskills.io/
// We publish a single skill: a markdown document describing how to use this
// site's public REST API. The sha256 is computed from the exact body that
// /.well-known/agent-skills/api-usage/SKILL.md serves, so an agent can verify
// the fetched skill matches this index.

export const revalidate = 3600

export async function GET() {
  const BASE = `https://${chainConfig.domain}`
  const body = skillBody()
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')

  const index = {
    $schema: 'https://agentskills.io/schema/v0.2.0/index.json',
    version: '0.2.0',
    publisher: {
      name: 'Measurable Data Token (MDT)',
      url: 'https://mdt.io',
    },
    skills: [
      {
        name: 'api-usage',
        type: 'markdown',
        description: `How to use the ${chainConfig.brandDomain} public REST API to query ${chainConfig.name} chain data (blocks, transactions, addresses, tokens, contracts).`,
        url: `${BASE}/.well-known/agent-skills/api-usage/SKILL.md`,
        sha256,
      },
    ],
  }

  return NextResponse.json(index, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
