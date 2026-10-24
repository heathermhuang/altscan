import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'
import { API_SURFACE } from '@/lib/api-surface'

// A single, human+agent-readable skill describing how to use the public REST API.
// Served as plain markdown so agentskills.io-style crawlers can cat it directly.

export const revalidate = 3600

const endpointLines = API_SURFACE.map(e => `- \`GET ${e.path}\` — ${e.summary}`).join('\n')

/** Shared with the discovery index, which SHOULD repeat the frontmatter description. */
export function skillDescription(): string {
  return `How to use the ${chainConfig.brandDomain} public REST API to query ${chainConfig.name} chain data (blocks, transactions, addresses, tokens, contracts).`
}

// The Agent Skills Discovery RFC requires YAML frontmatter with `name` and
// `description`. JSON.stringify yields a valid YAML double-quoted scalar.
export function skillBody(): string {
  const c = chainConfig
  return `---
name: api-usage
description: ${JSON.stringify(skillDescription())}
---

# ${c.brandDomain} — REST API usage

## Identity

- Name: ${c.brandDomain} REST API
- Base URL: https://${c.domain}/api/v1
- Chain: ${c.name} (chainId ${c.chainId})
- Human docs: https://${c.domain}/api-docs
- OpenAPI 3.1 spec of the endpoints below (parameters and response fields): https://${c.domain}/openapi.json
- Machine catalog (RFC 9727): https://${c.domain}/.well-known/api-catalog

## Auth

The \`GET\` chain-data endpoints listed below need no credential. Four endpoints take an API key in the \`X-API-Key\` header: \`/api/v1/query\`, \`/api/v1/keys\`, \`/api/v1/webhooks\` and \`/api/v1/contracts/{address}/call\`. A key gives the request its own rate-limit budget, and \`/api/v1/webhooks\` and \`GET /api/v1/keys\` answer 401 without one. How to get a key, and how to use OAuth where this origin has it switched on, is in https://${c.domain}/auth.md, which describes what this origin serves right now. Keyless requests are rate limited per IP; AI crawlers see additional limits on heavy paths (see \`/robots.txt\`).

## Endpoints

${endpointLines}

All responses are JSON. For human-friendly markdown representations, send \`Accept: text/markdown\` to any of:

- Static pages: \`/\`, \`/about\`, \`/api-docs\`, \`/developer\`
- Per-entity pages: \`/tx/{hash}\` (0x + 64 hex), \`/blocks/{number}\`

\`/address/*\` is HTML-only by design — its fan-out queries are too heavy for ad-hoc markdown requests. Use \`/api/v1/addresses/:address\` for structured access.

## Content policy

- Training: declined (\`Content-Signal: ai-train=no\` in robots.txt)
- Search indexing: allowed (\`search=yes\`)
- Agent retrieval / RAG: allowed (\`ai-input=yes\`)

## Versioning

- Skill schema: agentskills.io v0.2.0
- API version: v1 (breaking changes will move to \`/api/v2\`; no deprecation of v1 is planned)
`
}

export async function GET() {
  return new NextResponse(skillBody(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
