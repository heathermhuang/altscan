import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Minimal middleware — request-level bot throttling + abuse-source IP block.
 *
 * NOTE: Next.js middleware runs in Edge Runtime. process.memoryUsage() and
 * other Node.js APIs are NOT available here. All memory monitoring is handled
 * by instrumentation.ts which runs in the Node.js server process.
 *
 * Two layers:
 *   1. IP CIDR denylist — hard 403 for sustained-abuse source networks. Added
 *      after a 47.79.0.0/16 (Alibaba Cloud HK) botnet OOM-killed bnbscan-web
 *      in a multi-hour loop while spoofing real Chrome UAs (UA-based throttle
 *      below could not see it). Short-circuits before any route work.
 *   2. UA-based throttle — aggressive crawlers (Meta, ClaudeBot, GPTBot, etc.)
 *      that ignore robots.txt get 429 on heavy list pages.
 *
 * Real users on residential IPs and the listed UA families are unaffected.
 */
function ipToInt(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== 4) return 0
  let n = 0
  for (const p of parts) {
    const x = parseInt(p, 10)
    if (Number.isNaN(x) || x < 0 || x > 255) return 0
    n = ((n << 8) | x) >>> 0
  }
  return n
}

function parseCidr(cidr: string): { network: number; mask: number } {
  const [ip, bitsStr] = cidr.split('/')
  const bits = parseInt(bitsStr ?? '32', 10)
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  const network = ipToInt(ip ?? '') & mask
  return { network, mask }
}

// IPv4 CIDR denylist. Block ranges that have produced sustained, high-volume
// abuse with no legitimate-user footprint. Keep this list short and targeted.
const BLOCKED_IPV4_CIDRS = [
  // Alibaba Cloud HK — sustained Chrome-spoofing scraper, May 2026 incident.
  '47.79.0.0/16',
].map(parseCidr)

function getClientIp(request: NextRequest): string | null {
  // Cloudflare sits in front of Render for bnbscan.com/ethscan.io. Prefer
  // cf-connecting-ip when present; fall back to x-real-ip / first XFF hop.
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return null
}

function isBlockedIp(ip: string | null): boolean {
  if (!ip) return false
  const n = ipToInt(ip)
  if (n === 0) return false
  for (const { network, mask } of BLOCKED_IPV4_CIDRS) {
    if ((n & mask) === network) return true
  }
  return false
}

const AGGRESSIVE_BOT_UAS = [
  'ClaudeBot',
  'meta-externalagent',
  'meta-webindexer',
  'GPTBot',
  'Bytespider',
  'Amazonbot',
  'Applebot-Extended',
  'ImagesiftBot',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
  'anthropic-ai',
  'FacebookBot',
  'facebookexternalhit',
  'cohere-ai',
  'Diffbot',
  'omgilibot',
  'YouBot',
]

// Heavy paths that hit big tables (transactions/token_transfers/blocks).
// Home is ISR-cached and doesn't need throttling.
//
// The `/md/tx/` and `/md/block/` mirrors are listed explicitly — an aggressive
// crawler can request those directly, bypassing the canonical-path check, and
// each hit runs a DB lookup in the /md route handler.
const HEAVY_PATH_PREFIXES = [
  '/blocks',
  '/txs',
  '/tx/',
  '/address/',
  '/token/',
  '/block/',
  '/api/v1/blocks',
  '/api/v1/transactions',
  '/api/v1/addresses',
  '/api/v1/tokens',
  '/api/v1/contracts',
  '/md/tx/',
  '/md/block/',
]

function isAggressiveBot(ua: string | null): boolean {
  if (!ua) return false
  const normalized = ua.toLowerCase()
  for (const needle of AGGRESSIVE_BOT_UAS) {
    if (normalized.includes(needle.toLowerCase())) return true
  }
  return false
}

function isHeavyPath(pathname: string): boolean {
  for (const prefix of HEAVY_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) return true
  }
  return false
}

// Link response headers (RFC 8288) for agent discovery on the homepage.
// Advertises the API catalog, human API docs, and sitemap so agents can
// discover capabilities without guessing well-known paths.
const HOMEPAGE_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</api-docs>; rel="service-doc"; type="text/html"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</.well-known/agent-skills/index.json>; rel="https://agentskills.io/rel/index"; type="application/json"',
].join(', ')

// Pages that have a markdown representation at /md<path>. Keep in sync with
// STATIC_HANDLERS + dispatch() in app/md/[[...slug]]/route.ts.
const MARKDOWN_PATHS = new Set<string>(['/', '/about', '/developer', '/api-docs'])

// Dynamic patterns that also have markdown representations. PK lookups in the
// route handler — sub-millisecond and cached for a year by Cache-Control.
// /address/* is intentionally excluded; its fan-out queries are too heavy.
const MARKDOWN_DYNAMIC = [
  /^\/tx\/0x[0-9a-fA-F]{64}$/,
  /^\/block\/\d{1,12}$/,
]

function hasMarkdownRepresentation(pathname: string): boolean {
  if (MARKDOWN_PATHS.has(pathname)) return true
  for (const re of MARKDOWN_DYNAMIC) {
    if (re.test(pathname)) return true
  }
  return false
}

/**
 * Parse an Accept header and return true if `text/markdown` is preferred over
 * `text/html` (or HTML is absent). We treat a bare `Accept: text/markdown`
 * as preferring markdown; `Accept: text/html, text/markdown;q=0.9` as HTML.
 * This keeps browsers on HTML and lets agents opt in explicitly.
 */
function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false
  let mdQ = -1
  let htmlQ = -1
  for (const raw of accept.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const [type, ...paramsRaw] = part.split(';').map((s) => s.trim())
    let q = 1
    for (const p of paramsRaw) {
      if (p.startsWith('q=')) {
        const v = parseFloat(p.slice(2))
        if (!Number.isNaN(v)) q = v
      }
    }
    if (type === 'text/markdown') mdQ = Math.max(mdQ, q)
    else if (type === 'text/html') htmlQ = Math.max(htmlQ, q)
  }
  if (mdQ < 0) return false
  return mdQ > htmlQ
}

export function middleware(request: NextRequest) {
  const ua = request.headers.get('user-agent')
  const pathname = request.nextUrl.pathname

  if (isBlockedIp(getClientIp(request))) {
    return new NextResponse(null, {
      status: 403,
      headers: {
        'Cache-Control': 'no-store',
        'X-Blocked-Reason': 'abuse-source',
      },
    })
  }

  if (isAggressiveBot(ua) && isHeavyPath(pathname)) {
    return new NextResponse('Too Many Requests — this path is rate-limited for crawlers. See /robots.txt.', {
      status: 429,
      headers: {
        'Retry-After': '3600',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Throttle-Reason': 'aggressive-crawler',
      },
    })
  }

  // Markdown content negotiation — rewrite (not redirect) so the URL stays
  // canonical and caches key on Accept via the Vary header emitted by /md.
  if (
    !pathname.startsWith('/md') &&
    hasMarkdownRepresentation(pathname) &&
    prefersMarkdown(request.headers.get('accept'))
  ) {
    const url = request.nextUrl.clone()
    url.pathname = pathname === '/' ? '/md' : `/md${pathname}`
    const rewritten = NextResponse.rewrite(url)
    rewritten.headers.set('Vary', 'Accept')
    return rewritten
  }

  const response = NextResponse.next()
  if (pathname === '/') {
    response.headers.set('Link', HOMEPAGE_LINK_HEADER)
    response.headers.append('Vary', 'Accept')
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
}
