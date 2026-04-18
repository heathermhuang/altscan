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
const HEAVY_PATH_PREFIXES = [
  '/blocks',
  '/txs',
  '/tx/',
  '/address/',
  '/token/',
  '/block/',
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

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
}
