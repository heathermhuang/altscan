import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// llms.txt (https://llmstxt.org/) — a site map for AI agents. Points at the
// machine-friendly surfaces that already exist (markdown mirrors, REST API,
// api-catalog, agent-skills index) so agents don't have to scrape HTML to
// learn what the site offers. Policy must stay consistent with
// app/robots.txt/route.ts + lib/bot-policy.ts.

export async function GET() {
  const BASE = `https://${chainConfig.domain}`

  const body = `# ${chainConfig.brandDomain}

> ${chainConfig.brandDomain} is an open, independent ${chainConfig.name} block explorer
> maintained by Measurable Data Token (MDT). Live blocks, transactions, tokens,
> DEX trades, gas prices, whale tracking, and a free public REST API.

Recent chain state is kept on a rolling multi-day window; older transactions and
blocks are served live from ${chainConfig.name} RPC on request. Token pages and
list/analytics pages are durable.

## Machine-friendly access

- [Markdown mirrors](${BASE}/md): send \`Accept: text/markdown\` to /, /about,
  /developer, /api-docs, /tx/{hash}, /block/{number} to get markdown instead of HTML
- [REST API docs](${BASE}/api-docs): free public JSON API
- [API catalog (RFC 9727)](${BASE}/.well-known/api-catalog)
- [Agent skills index](${BASE}/.well-known/agent-skills/index.json)
- [Sitemap](${BASE}/sitemap.xml)

## Key pages

- [Latest blocks](${BASE}/blocks) · [Latest transactions](${BASE}/txs)
- [Token directory](${BASE}/token): tokens ranked by holders, with transfers and market data
- [DEX trades](${BASE}/dex) · [Gas tracker](${BASE}/gas) · [Charts](${BASE}/charts) · [Whale tracker](${BASE}/whales)
- [About](${BASE}/about)

## Usage policy

- AI retrieval and citation of public chain data: allowed (Content-Signal: ai-input=yes)
- AI training on this site's content: not permitted (ai-train=no)
- High-volume access: use the REST API (${BASE}/api-docs), not HTML scraping — see ${BASE}/robots.txt

## Related

- Sister explorer: ${chainConfig.peerUrl}
- Platform: [Altscan](https://altscan.io) — the open-source engine behind this site (AGPL-3.0)
`

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
