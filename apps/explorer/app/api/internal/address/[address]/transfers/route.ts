import { NextResponse } from 'next/server'
import { getDataProvider, isBotRequest } from '@/lib/providers'
import { guardInternalAddress } from '@/lib/internal-guard'
import { backfillEnabled, enqueueBackfill, shouldEnqueueBackfill } from '@/lib/backfill-trigger'
import {
  cacheUsable,
  carrySeamExclusions,
  decodeCursor,
  encodeCursor,
  transferCacheCoversFrom,
  readWatermark,
  serveLocalTokenTransfers,
  transferHandoffKeys,
  transferToRow,
  SEEN_CAP,
  TOP_HASH,
  TOP_LOG_INDEX,
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
      // O1: carry the seam exclusions while still inside the boundary block —
      // see history/route.ts.
      next = encodeCursor({
        source: 'local',
        ...lastBoundary,
        ...carrySeamExclusions(cur, lastBoundary.blockNumber),
      })
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

  // Hand off to the cache iff it holds rows below this page.
  if (cur.source === 'head' && usable && rows.length > 0) {
    const oldest = rows[rows.length - 1]
    const oldestBlock = Number(oldest.blockNumber)
    if (Number.isFinite(oldestBlock)) {
      // Contiguity, not mere existence below — see transferCacheCoversFrom.
      if (await transferCacheCoversFrom(address, oldestBlock).catch(() => false)) {
        // O1: sentinel-anchored handoff with pair-precise exclusions — see
        // history/route.ts. ALL-OR-SKIP: transferHandoffKeys returns null if
        // ANY boundary-block row lacks a valid logIndex — Moralis has returned
        // indexes inconsistently across calls, so a row null HERE may sit in
        // the cache under a valid index from an earlier fetch, and omitting it
        // from the exclusions would re-serve it as a seam duplicate. No
        // handoff then; the provider cursor below is always correct.
        const seenKeys = transferHandoffKeys(rows, oldestBlock)
        if (seenKeys && seenKeys.length > 0 && seenKeys.length <= SEEN_CAP) {
          next = encodeCursor({
            source: 'local',
            blockNumber: oldestBlock,
            txHash: TOP_HASH,
            logIndex: TOP_LOG_INDEX,
            boundaryBlock: oldestBlock,
            seenTransferKeys: seenKeys,
          })
        }
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
