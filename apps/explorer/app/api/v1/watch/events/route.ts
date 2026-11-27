import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { admitWatchRequest, requireWatchOwner, watchUnavailable } from '@/lib/watch-route'
import { decodeWatchCursor } from '@/lib/watch-cursor'
import { readWatchEvents } from '@/lib/watch-events'
import { hasSqlState, isUndefinedTable } from '@/lib/watch-addresses'
import { positiveIntEnv } from '@/lib/env'

export const dynamic = 'force-dynamic'

/**
 * Feed reads in flight per process. The web pool is 3 connections and each read holds one for up to its 5 s
 * statement timeout, so past the cap the route answers 503 at once instead of queueing (cf. api-tx-lookup.ts).
 */
const MAX_CONCURRENT = positiveIntEnv('WATCH_FEED_MAX_CONCURRENT', 1)
let running = 0

const busy = () => NextResponse.json({ error: 'Wallet watch is busy; retry shortly' }, { status: 503, headers: { 'Retry-After': '2' } })

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : null
}

// GET: the owner's wallet-watch events since `cursor` (none: start at the tip)
export async function GET(request: Request) {
  const refused = await admitWatchRequest(request)
  if (refused) return refused
  const params = new URL(request.url).searchParams
  const who = await requireWatchOwner(request, params.get('owner'))
  if (!who.ok) return who.response

  const limit = parseLimit(params.get('limit'))
  if (limit === null) return NextResponse.json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, { status: 400 })
  const rawCursor = params.get('cursor')
  const cursor = rawCursor === null ? null : decodeWatchCursor(rawCursor)
  if (rawCursor !== null && cursor === null) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })

  // Adoption measurement: distinct owners per week, without logging their addresses.
  console.log(`[watch] owner=${crypto.createHash('sha256').update(who.owner).digest('hex').slice(0, 8)}`)

  if (running >= MAX_CONCURRENT) return busy()
  running++
  try {
    const result = await readWatchEvents(db, who.owner, cursor, limit)
    if (result.status === 'not_ready') return watchUnavailable()
    if (result.status === 'gone') {
      return NextResponse.json({
        error: 'This cursor is older than the retained window; the events after it are no longer stored',
        oldestAvailableBlock: result.oldestAvailableBlock,
      }, { status: 410 })
    }
    return NextResponse.json(result.body)
  } catch (e) {
    if (isUndefinedTable(e)) return watchUnavailable()
    if (hasSqlState(e, '57014')) return busy() // statement_timeout: the feed query ran past its 5 s budget
    throw e
  } finally {
    running--
  }
}
