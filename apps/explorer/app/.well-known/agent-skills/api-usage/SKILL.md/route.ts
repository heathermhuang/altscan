import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// A single, human+agent-readable skill describing how to use the public REST API.
// Served as plain markdown so agentskills.io-style crawlers can cat it directly.

export const revalidate = 3600

export function skillBody(): string {
  const c = chainConfig
  return `# ${c.brandDomain} — REST API usage

## Identity

- Name: ${c.brandDomain} REST API
- Base URL: https://${c.domain}/api/v1
- Chain: ${c.name} (chainId ${c.chainId})
- Human docs: https://${c.domain}/api-docs
- Machine catalog (RFC 9727): https://${c.domain}/.well-known/api-catalog

## Auth

All \`/api/v1/*\` endpoints are public and require no authentication. There is no OAuth authorization server and no OAuth-protected resource at this origin; do not look for \`/.well-known/openid-configuration\` or \`/.well-known/oauth-protected-resource\` — they are intentionally absent. Rate limiting is per IP; AI crawlers see additional limits on heavy paths (see \`/robots.txt\`).

## Endpoints

- \`GET /api/v1/stats\` — network stats (latest block, tx count, token count, avg gas price)
- \`GET /api/v1/blocks?limit=N\` — recent blocks
- \`GET /api/v1/blocks/:number\` — one block with txs
- \`GET /api/v1/transactions?limit=N\` — recent transactions
- \`GET /api/v1/transactions/:hash\` — one transaction with receipt
- \`GET /api/v1/addresses/:address\` — address summary (balance, nonce, tx count)
- \`GET /api/v1/tokens\` — token list
- \`GET /api/v1/tokens/:contract\` — one token (metadata + holder count)
- \`GET /api/v1/contracts/:address\` — verified-contract metadata

All responses are JSON. For human-friendly markdown representations, send \`Accept: text/markdown\` to any of:

- Static pages: \`/\`, \`/about\`, \`/api-docs\`, \`/developer\`
- Per-entity pages: \`/tx/{hash}\` (0x + 64 hex), \`/block/{number}\`

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
