import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// ARD capability manifest: an AI Catalog (https://github.com/Agent-Card/ai-catalog)
// at the well-known path ARD (https://agenticresourcediscovery.org/) discovers.
// It lists the one AI artifact this site publishes, the api-usage Agent Skill.
// There is no MCP server, A2A agent or OAuth server at this origin, so none is
// listed. The skill's description lives in its own frontmatter, which the spec
// makes the authoritative source.

export const revalidate = 3600

export async function GET() {
  const c = chainConfig
  const BASE = `https://${c.domain}`

  const catalog = {
    specVersion: '1.0',
    host: {
      displayName: c.brandDomain,
      identifier: c.domain,
      documentationUrl: `${BASE}/api-docs`,
    },
    entries: [
      {
        identifier: `urn:air:${c.domain}:skill:api-usage`,
        displayName: `${c.brandDomain} REST API usage`,
        type: 'application/agent-skills+md',
        url: `${BASE}/.well-known/agent-skills/api-usage/SKILL.md`,
        representativeQueries: [
          `look up a ${c.name} transaction by hash`,
          `get the ${c.currency} balance and transaction count of an address`,
          `list the latest ${c.name} blocks`,
          `how many holders does a ${c.name} token have`,
        ],
      },
    ],
  }

  return NextResponse.json(catalog, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
