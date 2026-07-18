import { NextResponse } from 'next/server'
import { getDataProvider, isBotRequest } from '@/lib/providers'
import { guardInternalAddress } from '@/lib/internal-guard'
import { backfillEnabled, enqueueBackfill, shouldEnqueueBackfill } from '@/lib/backfill-trigger'
import {
  cacheUsable,
  decodeCursor,
  encodeCursor,
  transferCacheCoversFrom,
  readWatermark,
  serveLocalTokenTransfers,
  transferToRow,
  TOP_TRANSFER_BOUNDARY,
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

  // ── Gated OFF: byte-identical A4a behavior (see history/route.ts) ─────────
  if (!backfillEnabled()) {
    const result = provider ? await provider.getAddressTokenTransfers(address, cursor || undefined) : null
    if (!result || !result.ok) {
      return NextResponse.json(
        { transfers: [], cursor: null, limited: true, reason: result ? result.reason : 'not_configured' },
        { status: 200, headers: NO_STORE },
      )
    }
    return NextResponse.json(
      { transfers: result.data.transfers, cursor: result.data.cursor, limited: false },
      { headers: NO_STORE },
    )
  }

  const cur = decodeCursor(cursor)
  // See history/route.ts: a watermark read failure degrades to provider-only
  // rather than breaking the live head.
  let wm = null as Awaited<ReturnType<typeof readWatermark>>
  try {
    wm = await readWatermark('token_transfers', address)
  } catch {
    wm = null
  }
  const usable = cacheUsable(wm)

  if (shouldEnqueueBackfill({
    backfillEnabled: true,
    isBot: isBotRequest(_req.headers.get('user-agent')),
    watermarkExists: wm !== null,
  })) {
    void enqueueBackfill('token_transfers', address)
  }

  // Cached page.
  if (usable && cur.source === 'local') {
    const { rows, lastBoundary, hasMore } = await serveLocalTokenTransfers(address, cur)
    let next: string | null = null
    if (hasMore && lastBoundary) {
      next = encodeCursor({ source: 'local', ...lastBoundary })
    } else if (wm!.status !== 'complete' && wm!.oldestCursor) {
      next = encodeCursor({ source: 'provider', providerCursor: wm!.oldestCursor })
    }
    return NextResponse.json(
      {
        transfers: rows,
        cursor: next,
        source: 'local',
        complete: wm!.status === 'complete' && next === null,
        limited: false,
      },
      { headers: NO_STORE },
    )
  }

  // Live head, or an explicit provider tail page.
  const provCursor = cur.source === 'provider' ? cur.providerCursor : undefined
  const result = provider ? await provider.getAddressTokenTransfers(address, provCursor) : null

  if (!result || !result.ok) {
    const outage = !!result && !result.ok && result.reason !== 'not_configured'
    if (outage && usable && cur.source === 'head') {
      const { rows, lastBoundary, hasMore } = await serveLocalTokenTransfers(address, TOP_TRANSFER_BOUNDARY)
      if (rows.length > 0) {
        const fbNext = hasMore && lastBoundary
          ? encodeCursor({ source: 'local', ...lastBoundary })
          : (wm && wm.status !== 'complete' && wm.oldestCursor
              ? encodeCursor({ source: 'provider', providerCursor: wm.oldestCursor })
              : null)
        return NextResponse.json(
          {
            transfers: rows,
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
      { transfers: [], cursor: null, limited: true, reason: result ? result.reason : 'not_configured' },
      { status: 200, headers: NO_STORE },
    )
  }

  const rows = result.data.transfers.map(transferToRow)
  let next: string | null = null

  // Hand off to the cache iff it holds rows below this page. A transfer whose
  // logIndex is null cannot anchor a keyset boundary, so skip the handoff
  // rather than coerce it — the provider cursor is always a correct fallback.
  if (cur.source === 'head' && usable && rows.length > 0) {
    const oldest = rows[rows.length - 1]
    const oldestLogIndex = oldest.logIndex == null ? null : Number(oldest.logIndex)
    const oldestBlock = Number(oldest.blockNumber)
    // A null logIndex cannot anchor a keyset boundary, so skip the handoff
    // rather than coerce it — the provider cursor is always a correct fallback.
    if (oldestLogIndex != null && Number.isSafeInteger(oldestLogIndex) && Number.isFinite(oldestBlock)) {
      // Contiguity, not mere existence below — see transferCacheCoversFrom.
      if (await transferCacheCoversFrom(address, oldestBlock).catch(() => false)) {
        next = encodeCursor({
          source: 'local',
          blockNumber: oldestBlock,
          txHash: oldest.txHash,
          logIndex: oldestLogIndex,
        })
      }
    }
  }
  if (!next && result.data.cursor) {
    next = encodeCursor({ source: 'provider', providerCursor: result.data.cursor })
  }

  return NextResponse.json(
    { transfers: rows, cursor: next, source: 'provider', limited: false },
    { headers: NO_STORE },
  )
}
