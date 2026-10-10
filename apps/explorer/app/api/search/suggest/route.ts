import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { chainConfig } from '@/lib/chain'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/api-rate-limit'
import { shapeSuggestions, suggestPrefix, suggestQuery } from '@/lib/token-suggest'
import { withTimeout } from '@/lib/with-timeout'
import { swallow } from '@/lib/observability'

// An API route may be dynamic; a page may not (AGENTS.md: ISR only).
export const dynamic = 'force-dynamic'

/** The typeahead is not worth a visitor's wait: past this it shows nothing rather than a late list. */
const TIMEOUT_MS = 1500

/**
 * GET /api/search/suggest?q=: the top five tokens whose symbol starts with q, for the header search
 * box. Fewer than two characters, or more than a symbol can hold, is an empty list without a query.
 */
export async function GET(request: Request) {
  const prefix = suggestPrefix(new URL(request.url).searchParams.get('q'))
  if (!prefix) return NextResponse.json({ tokens: [] }, { headers: { 'cache-control': 'public, max-age=30' } })

  // Its own bucket: a visitor typing must not use up the /api/v1 budget (rl:<ip>), like /api/internal's.
  if (!(await checkRateLimit(`suggest:${clientIpFromHeaders(request.headers)}`))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'cache-control': 'no-store' } })
  }

  try {
    const rows = await withTimeout(suggestQuery(db, prefix), TIMEOUT_MS)
    return NextResponse.json(
      { tokens: shapeSuggestions(rows, prefix, chainConfig.key) },
      { headers: { 'cache-control': 'public, max-age=30' } },
    )
  } catch (e) {
    swallow('search/suggest', e)
    return NextResponse.json({ error: 'Suggestions unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
