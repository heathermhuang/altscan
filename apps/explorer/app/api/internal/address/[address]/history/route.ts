import { NextResponse } from 'next/server'
import { getDataProvider, isBotRequest } from '@/lib/providers'
import { guardInternalAddress } from '@/lib/internal-guard'
import { backfillEnabled, enqueueBackfill, shouldEnqueueBackfill } from '@/lib/backfill-trigger'
import {
  cacheUsable,
  decodeCursor,
  encodeCursor,
  cacheCoversFrom,
  readWatermark,
  serveLocalAddressTxs,
  txToHistoryRow,
  TOP_BOUNDARY,
} from '@/lib/backfill-serve'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'private, no-store' }

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const guard = await guardInternalAddress(_req, address)
  if (guard) return guard
  const url = new URL(_req.url)
  const cursor = url.searchParams.get('cursor') ?? undefined
  const provider = getDataProvider()

  // ── Gated OFF: byte-identical A4a behavior ────────────────────────────────
  // This early return is what makes A4b-1 a true no-op, and it is NOT optional.
  // Falling through with the flag off would still run `cursor` through
  // decodeCursor, which turns an opaque provider cursor into `{source:'head'}`
  // and silently restarts pagination at page 1.
  if (!backfillEnabled()) {
    const result = provider ? await provider.getAddressHistory(address, cursor || undefined) : null
    if (!result || !result.ok) {
      return NextResponse.json(
        { result: [], cursor: null, limited: true, reason: result ? result.reason : 'not_configured' },
        { status: 200, headers: NO_STORE },
      )
    }
    return NextResponse.json(
      { result: result.data.txs, cursor: result.data.cursor, totalTxs: result.data.totalTxs, limited: false },
      { headers: NO_STORE },
    )
  }

  // ── Backfill enabled ──────────────────────────────────────────────────────
  const cur = decodeCursor(cursor)
  // A watermark read failure must NOT break the live head: the cache is an
  // optimization, the provider is the source of truth. Degrade to provider-only
  // rather than 500ing page 1 because Postgres blinked.
  let wm = null as Awaited<ReturnType<typeof readWatermark>>
  try {
    wm = await readWatermark('address_txs', address)
  } catch {
    wm = null
  }
  const usable = cacheUsable(wm)

  // Warm the cache for pagination on a first human view (fire-and-forget).
  if (shouldEnqueueBackfill({
    backfillEnabled: true,
    isBot: isBotRequest(_req.headers.get('user-agent')),
    watermarkExists: wm !== null,
  })) {
    void enqueueBackfill('address_txs', address)
  }

  // Step 3 — a cached page. Only reachable via a cursor we ourselves minted.
  if (usable && cur.source === 'local') {
    const { rows, lastBoundary, hasMore } = await serveLocalAddressTxs(address, cur)
    let next: string | null = null
    if (hasMore && lastBoundary) {
      next = encodeCursor({ source: 'local', ...lastBoundary })
    } else if (wm!.status !== 'complete' && wm!.oldestCursor) {
      // capped|partial → resume the deep tail where the WORKER stopped.
      next = encodeCursor({ source: 'provider', providerCursor: wm!.oldestCursor })
    }
    return NextResponse.json(
      {
        result: rows,
        cursor: next,
        source: 'local',
        complete: wm!.status === 'complete' && next === null,
        limited: false,
      },
      { headers: NO_STORE },
    )
  }

  // Steps 1 & 4 — the live head, or an explicit provider tail page.
  const provCursor = cur.source === 'provider' ? cur.providerCursor : undefined
  const result = provider ? await provider.getAddressHistory(address, provCursor) : null

  if (!result || !result.ok) {
    // Outage fallback: serve the cached head rather than an error banner.
    // Deliberately narrow — only on the HEAD page, and never for
    // 'not_configured', which is a deployment mistake we must not paper over.
    const outage = !!result && !result.ok && result.reason !== 'not_configured'
    if (outage && usable && cur.source === 'head') {
      const { rows, lastBoundary, hasMore } = await serveLocalAddressTxs(address, TOP_BOUNDARY)
      if (rows.length > 0) {
        // Continue the same way the normal local path does: more cached rows,
        // else resume the provider tail. Returning null here would make a cache
        // of 1-25 rows look permanently exhausted.
        const fbNext = hasMore && lastBoundary
          ? encodeCursor({ source: 'local', ...lastBoundary })
          : (wm && wm.status !== 'complete' && wm.oldestCursor
              ? encodeCursor({ source: 'provider', providerCursor: wm.oldestCursor })
              : null)
        return NextResponse.json(
          {
            result: rows,
            cursor: fbNext,
            source: 'local',
            stale: true,
            complete: false,
            limited: false,
          },
          { headers: NO_STORE },
        )
      }
    }
    return NextResponse.json(
      { result: [], cursor: null, limited: true, reason: result ? result.reason : 'not_configured' },
      { status: 200, headers: NO_STORE },
    )
  }

  const rows = result.data.txs.map(txToHistoryRow)
  let next: string | null = null

  // Step 2 — hand off to the cache iff it actually holds rows below this page.
  if (cur.source === 'head' && usable && rows.length > 0) {
    const oldest = rows[rows.length - 1]
    const oldestBlock = Number(oldest.blockNumber)
    // Hand off ONLY if the cache is contiguous with this page — see
    // cacheCoversFrom. Existence of rows *below* is not enough; it silently
    // skips everything indexed after the last backfill run.
    if (Number.isFinite(oldestBlock) && await cacheCoversFrom(address, oldestBlock).catch(() => false)) {
      next = encodeCursor({ source: 'local', blockNumber: oldestBlock, txHash: oldest.hash })
    }
  }
  if (!next && result.data.cursor) {
    next = encodeCursor({ source: 'provider', providerCursor: result.data.cursor })
  }

  return NextResponse.json(
    { result: rows, cursor: next, totalTxs: result.data.totalTxs, source: 'provider', limited: false },
    { headers: NO_STORE },
  )
}
