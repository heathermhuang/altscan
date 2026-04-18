import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { chainConfig } from '@/lib/chain'

// Markdown-for-Agents (content negotiation).
// Middleware routes incoming requests with `Accept: text/markdown` here;
// we emit a markdown representation of a small, curated set of public pages.
// Dynamic pages (tx/block/address) are intentionally excluded — they'd require
// per-request DB reads and would bypass ISR. If an agent wants per-entity data
// it should use the REST API at /api/v1/* (documented at /api-docs).

type Handler = () => string

export const revalidate = 3600

function homepageMarkdown(): string {
  const c = chainConfig
  return [
    `# ${c.brandDomain} — ${c.tagline}`,
    '',
    `${c.brandDomain} is an open, independent ${c.name} block explorer maintained by Measurable Data Token (MDT).`,
    '',
    '## What you can do here',
    '',
    `- Browse recent [blocks](https://${c.domain}/blocks) and [transactions](https://${c.domain}/txs) on ${c.name}.`,
    `- Inspect an [address](https://${c.domain}/) or [transaction](https://${c.domain}/) by hash via the top search bar.`,
    `- Explore [tokens](https://${c.domain}/token), [DEX trades](https://${c.domain}/dex), and [whales](https://${c.domain}/whales).`,
    `- Check [gas prices](https://${c.domain}/gas) and [charts](https://${c.domain}/charts).`,
    '',
    '## For agents and developers',
    '',
    `- Public REST API: \`https://${c.domain}/api/v1/*\` — see [/api-docs](https://${c.domain}/api-docs).`,
    `- API catalog (RFC 9727): \`https://${c.domain}/.well-known/api-catalog\`.`,
    `- Agent skills index: \`https://${c.domain}/.well-known/agent-skills/index.json\`.`,
    `- Content negotiation: request this or any markdown-enabled page with \`Accept: text/markdown\`.`,
    '',
    '## Crawl policy',
    '',
    `See [/robots.txt](https://${c.domain}/robots.txt) for AI crawler rules and Content-Signal directives.`,
    '',
  ].join('\n')
}

function aboutMarkdown(): string {
  const c = chainConfig
  return [
    `# About ${c.brandDomain}`,
    '',
    `${c.brandDomain} is an independent ${c.name} block explorer maintained by Measurable Data Token (MDT). It indexes blocks, transactions, logs, token transfers, and DEX trades directly from a ${c.name} full node and exposes them through a web UI and a public REST API.`,
    '',
    '## Operated by',
    '',
    '- Measurable Data Token (MDT) — https://mdt.io',
    '- Source/brand: https://github.com/nicemdt',
    '',
    '## Sister site',
    '',
    c.key === 'bnb'
      ? '- Ethereum explorer: https://ethscan.io'
      : '- BNB Chain explorer: https://bnbscan.com',
    '',
    '## Data retention',
    '',
    'Recent chain state is retained in the explorer database; older blocks are pruned on a rolling window to keep query latency low. For full historical data, use a node RPC directly.',
    '',
  ].join('\n')
}

function developerMarkdown(): string {
  const c = chainConfig
  return [
    `# Developer resources — ${c.brandDomain}`,
    '',
    `Programmatic access to ${c.name} chain data.`,
    '',
    '## Endpoints',
    '',
    `- REST API base: \`https://${c.domain}/api/v1\``,
    `- Human docs: https://${c.domain}/api-docs`,
    `- Linkset (RFC 9727): https://${c.domain}/.well-known/api-catalog`,
    `- Health: https://${c.domain}/api/health`,
    '',
    '## Content negotiation',
    '',
    'Send `Accept: text/markdown` on supported pages (`/`, `/about`, `/api-docs`, `/developer`) to receive a markdown representation instead of HTML. Browsers and search crawlers continue to receive HTML by default.',
    '',
    '## Rate limiting',
    '',
    'Public endpoints are rate-limited per IP. Aggressive AI crawlers are additionally throttled on heavy paths (`/blocks`, `/txs`, `/tx/`, `/address/`, `/token/`, `/block/`) per `/robots.txt`.',
    '',
  ].join('\n')
}

// `/api-docs` is rendered from a long TSX template. Rather than duplicate its
// endpoint list in markdown and risk drift, we emit a short pointer.
function apiDocsMarkdown(): string {
  const c = chainConfig
  return [
    `# API documentation — ${c.brandDomain}`,
    '',
    `The full endpoint reference is served as HTML at https://${c.domain}/api-docs. The machine-readable catalog is at https://${c.domain}/.well-known/api-catalog (RFC 9727 linkset).`,
    '',
    '## Endpoint families',
    '',
    `- \`GET /api/v1/stats\` — network stats`,
    `- \`GET /api/v1/blocks\` — recent blocks + by number`,
    `- \`GET /api/v1/transactions\` — recent txs + by hash`,
    `- \`GET /api/v1/addresses/:address\` — address summary`,
    `- \`GET /api/v1/tokens\` — token list + by contract`,
    `- \`GET /api/v1/contracts\` — verified-contract metadata`,
    '',
    '## Auth',
    '',
    'All documented endpoints are public and require no authentication. Admin-only endpoints are out of scope for agent integrations.',
    '',
  ].join('\n')
}

const HANDLERS: Record<string, Handler> = {
  '/': homepageMarkdown,
  '/about': aboutMarkdown,
  '/developer': developerMarkdown,
  '/api-docs': apiDocsMarkdown,
}

function slugToPath(slug: string[] | undefined): string {
  if (!slug || slug.length === 0) return '/'
  return '/' + slug.join('/')
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params
  const path = slugToPath(slug)
  const handler = HANDLERS[path]

  if (!handler) {
    return new NextResponse(
      `# Not available as markdown\n\nPath \`${path}\` does not have a markdown representation. HTML is served at https://${chainConfig.domain}${path}. For structured data, use the REST API at https://${chainConfig.domain}/api/v1/*.\n`,
      {
        status: 406,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Vary': 'Accept',
        },
      },
    )
  }

  const body = handler()
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Vary': 'Accept',
    },
  })
}
