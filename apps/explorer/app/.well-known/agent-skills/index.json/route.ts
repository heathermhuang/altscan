import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { chainConfig } from '@/lib/chain'
import { skillBody, skillDescription } from '../api-usage/SKILL.md/route'

// Agent Skills Discovery index, v0.2.0 —
// https://github.com/cloudflare/agent-skills-discovery-rfc
// We publish a single skill: a markdown document describing how to use this
// site's public REST API. The digest is computed from the exact body that
// /.well-known/agent-skills/api-usage/SKILL.md serves, so an agent can verify
// the fetched skill matches this index. Clients SHOULD NOT process an index
// whose $schema they don't recognise, so it must be the RFC's URI verbatim.

export const revalidate = 3600

const SKILLS_INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

export async function GET() {
  const BASE = `https://${chainConfig.domain}`
  const sha256 = createHash('sha256').update(skillBody(), 'utf8').digest('hex')

  const index = {
    $schema: SKILLS_INDEX_SCHEMA,
    publisher: {
      name: 'Measurable Data Token (MDT)',
      url: 'https://mdt.io',
    },
    skills: [
      {
        name: 'api-usage',
        type: 'skill-md',
        description: skillDescription(),
        url: `${BASE}/.well-known/agent-skills/api-usage/SKILL.md`,
        digest: `sha256:${sha256}`,
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
