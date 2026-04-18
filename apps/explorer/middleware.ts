import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Minimal middleware — request-level bot throttling.
 *
 * NOTE: Next.js middleware runs in Edge Runtime. process.memoryUsage() and
 * other Node.js APIs are NOT available here. All memory monitoring is handled
 * by instrumentation.ts which runs in the Node.js server process.
 *
 * Bot throttling: aggressive crawlers (Meta, ClaudeBot, GPTBot, etc.) ignore
 * robots.txt and saturate the DB connection pool on heavy list pages like
 * /blocks and /txs during VACUUM or any load spike. We return 429 with a
 * long Retry-After for these UAs on DB-heavy paths. Real users are
 * unaffected — this matches on UA substrings only, not IPs.
 */
const AGGRESSIVE_BOT_UAS = [
  'ClaudeBot',
  'meta-externalagent',
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
  '/md/tx/',
  '/md/block/',
]

function isAggressiveBot(ua: string | null): boolean {
  if (!ua) return false
  for (const needle of AGGRESSIVE_BOT_UAS) {
    if (ua.includes(needle)) return true
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
