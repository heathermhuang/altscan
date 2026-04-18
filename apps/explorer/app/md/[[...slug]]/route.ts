import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { chainConfig } from '@/lib/chain'
import { formatNativeToken, formatGwei, formatNumber, safeBigInt } from '@/lib/format'

// Markdown-for-Agents (content negotiation).
// Middleware routes incoming requests with `Accept: text/markdown` here;
// we emit a markdown representation for a curated set of pages.
//
// Static pages (/, /about, /developer, /api-docs) — handled by STATIC_HANDLERS.
// Dynamic pages (/tx/:hash, /block/:n) — handled by dispatchDynamic; PK lookups
// are sub-millisecond and cache for a year (mined entities are immutable).
// /address/* is intentionally excluded — fan-out queries against a bloated
// transactions heap can hang for minutes; agents should use /api/v1/addresses.

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
    `- Per-entity markdown: \`/tx/{hash}\` and \`/block/{number}\` also support \`Accept: text/markdown\`.`,
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
    'Send `Accept: text/markdown` on supported pages to receive a markdown representation instead of HTML. Browsers and search crawlers continue to receive HTML by default.',
    '',
    'Markdown-enabled paths:',
    '- Static: `/`, `/about`, `/api-docs`, `/developer`',
    '- Dynamic (PK lookups, immutable): `/tx/{hash}`, `/block/{number}`',
    '',
    '`/address/*` is intentionally HTML-only — its fan-out queries are too heavy for ad-hoc requests. Use `/api/v1/addresses/{addr}` for structured access.',
    '',
    '## Rate limiting',
    '',
    'Public endpoints are rate-limited per IP. Aggressive AI crawlers are additionally throttled on heavy paths (`/blocks`, `/txs`, `/tx/`, `/address/`, `/token/`, `/block/`) per `/robots.txt`.',
    '',
  ].join('\n')
}

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

const STATIC_HANDLERS: Record<string, Handler> = {
  '/': homepageMarkdown,
  '/about': aboutMarkdown,
  '/developer': developerMarkdown,
  '/api-docs': apiDocsMarkdown,
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const BLOCK_NUMBER = /^\d{1,12}$/

async function txMarkdown(hash: string): Promise<string | null> {
  const c = chainConfig
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.hash, hash.toLowerCase()))
    .limit(1)
  const tx = rows[0]
  if (!tx) return null
  const value = formatNativeToken(tx.value, 6)
  const gasPriceGwei = formatGwei(tx.gasPrice)
  const lines: string[] = [
    `# Transaction \`${tx.hash}\``,
    '',
    `On ${c.name} (chainId ${c.chainId}). Indexed by ${c.brandDomain}.`,
    '',
    '## Summary',
    '',
    `- Status: ${tx.status ? 'success' : 'failed'}`,
    `- Block: [${formatNumber(tx.blockNumber)}](https://${c.domain}/block/${tx.blockNumber})`,
    `- Timestamp: ${tx.timestamp.toISOString()}`,
    `- From: \`${tx.fromAddress}\``,
    `- To: ${tx.toAddress ? `\`${tx.toAddress}\`` : '_contract creation_'}`,
    `- Value: ${value} ${c.currency}`,
    `- Gas used: ${formatNumber(safeBigInt(tx.gasUsed))} / ${formatNumber(safeBigInt(tx.gas))} limit`,
    `- Gas price: ${gasPriceGwei} gwei`,
    `- Nonce: ${tx.nonce ?? 'unknown'}`,
    `- Tx index in block: ${tx.txIndex}`,
  ]
  if (tx.methodId) lines.push(`- Method id: \`${tx.methodId}\``)
  if (tx.txType !== null && tx.txType !== undefined) lines.push(`- Tx type: ${tx.txType}`)
  lines.push(
    '',
    '## Structured data',
    '',
    `For machine-readable JSON, call \`GET https://${c.domain}/api/v1/transactions/${tx.hash}\`.`,
    '',
    '## Web view',
    '',
    `- HTML: https://${c.domain}/tx/${tx.hash}`,
    '',
  )
  return lines.join('\n')
}

async function blockMarkdown(num: number): Promise<string | null> {
  const c = chainConfig
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.number, num))
    .limit(1)
  const block = rows[0]
  if (!block) return null
  const lines: string[] = [
    `# Block ${formatNumber(block.number)}`,
    '',
    `On ${c.name} (chainId ${c.chainId}). Indexed by ${c.brandDomain}.`,
    '',
    '## Summary',
    '',
    `- Hash: \`${block.hash}\``,
    `- Parent: \`${block.parentHash}\``,
    `- Timestamp: ${block.timestamp.toISOString()}`,
    `- Miner / proposer: \`${block.miner}\``,
    `- Transaction count: ${formatNumber(block.txCount)}`,
    `- Gas used: ${formatNumber(safeBigInt(block.gasUsed))} / ${formatNumber(safeBigInt(block.gasLimit))} limit`,
    `- Size: ${formatNumber(block.size)} bytes`,
  ]
  if (block.baseFeePerGas) {
    lines.push(`- Base fee per gas: ${formatGwei(block.baseFeePerGas)} gwei`)
  }
  lines.push(
    '',
    '## Structured data',
    '',
    `For machine-readable JSON, call \`GET https://${c.domain}/api/v1/blocks/${block.number}\`.`,
    '',
    '## Web view',
    '',
    `- HTML: https://${c.domain}/block/${block.number}`,
    '',
  )
  return lines.join('\n')
}

function notFoundMarkdown(kind: 'tx' | 'block', id: string): string {
  const c = chainConfig
  return [
    `# ${kind === 'tx' ? 'Transaction' : 'Block'} not found`,
    '',
    `\`${id}\` is not in the ${c.brandDomain} index. Either it has not been indexed yet, or it has fallen outside the retention window. Recent chain state is kept on a rolling window; for full history, query a node RPC directly.`,
    '',
    `- Web view: https://${c.domain}/${kind}/${id}`,
    `- API: https://${c.domain}/api/v1/${kind === 'tx' ? 'transactions' : 'blocks'}/${id}`,
    '',
  ].join('\n')
}

function unsupportedMarkdown(path: string): string {
  const c = chainConfig
  return `# Not available as markdown\n\nPath \`${path}\` does not have a markdown representation. HTML is served at https://${c.domain}${path}. For structured data, use the REST API at https://${c.domain}/api/v1/*.\n`
}

function slugToPath(slug: string[] | undefined): string {
  if (!slug || slug.length === 0) return '/'
  return '/' + slug.join('/')
}

type RouteResult = { body: string; status: number; cacheControl: string }

async function dispatch(path: string): Promise<RouteResult> {
  const staticHandler = STATIC_HANDLERS[path]
  if (staticHandler) {
    return {
      body: staticHandler(),
      status: 200,
      cacheControl: 'public, max-age=3600',
    }
  }

  const txMatch = /^\/tx\/(.+)$/.exec(path)
  if (txMatch) {
    const hash = txMatch[1]
    if (!TX_HASH.test(hash)) {
      return { body: notFoundMarkdown('tx', hash), status: 404, cacheControl: 'public, max-age=60' }
    }
    try {
      const md = await txMarkdown(hash)
      if (!md) {
        return { body: notFoundMarkdown('tx', hash), status: 404, cacheControl: 'public, max-age=60' }
      }
      return { body: md, status: 200, cacheControl: 'public, max-age=31536000, immutable' }
    } catch {
      return { body: notFoundMarkdown('tx', hash), status: 503, cacheControl: 'no-store' }
    }
  }

  const blockMatch = /^\/block\/(.+)$/.exec(path)
  if (blockMatch) {
    const raw = blockMatch[1]
    if (!BLOCK_NUMBER.test(raw)) {
      return { body: notFoundMarkdown('block', raw), status: 404, cacheControl: 'public, max-age=60' }
    }
    const num = Number(raw)
    if (!Number.isSafeInteger(num)) {
      return { body: notFoundMarkdown('block', raw), status: 404, cacheControl: 'public, max-age=60' }
    }
    try {
      const md = await blockMarkdown(num)
      if (!md) {
        return { body: notFoundMarkdown('block', raw), status: 404, cacheControl: 'public, max-age=60' }
      }
      return { body: md, status: 200, cacheControl: 'public, max-age=31536000, immutable' }
    } catch {
      return { body: notFoundMarkdown('block', raw), status: 503, cacheControl: 'no-store' }
    }
  }

  return { body: unsupportedMarkdown(path), status: 406, cacheControl: 'public, max-age=300' }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params
  const path = slugToPath(slug)
  const { body, status, cacheControl } = await dispatch(path)
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': cacheControl,
      'Vary': 'Accept',
    },
  })
}
