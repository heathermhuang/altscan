/**
 * Track A4b — serving `live head ∪ cached deep tail`.
 *
 * THE RULE, newest→oldest: **page 1 is ALWAYS live from the provider.**
 *
 * The backfill worker pages newest→oldest, so `backfill_address_txs` fills from
 * some point downward and only ever grows *downward*. Handing page 1 to that
 * cache would freeze the head: transactions newer than the last backfill run
 * would never appear, and because tx rows are immutable there is nothing to
 * invalidate — the view would just be quietly, permanently wrong.
 *
 * So:
 *   1. no cursor            → provider, live. Note page 1's oldest (block, hash).
 *   2. next cursor          → a LOCAL boundary iff the cache holds rows strictly
 *                             below page 1's oldest; otherwise the provider's own.
 *   3. cursor.source=local  → keyset page from the cache. The `< page1-oldest`
 *                             boundary dedups the head overlap by construction.
 *                             On the last local row: null if the watermark is
 *                             `complete`, else resume the provider tail from
 *                             `watermark.oldestCursor` (where the WORKER stopped
 *                             — not page one).
 *   4. cursor.source=provider → straight passthrough, cursor re-wrapped.
 *
 * `capped` is NOT `complete`: its tail beyond the row cap still lives at the
 * provider, so it takes the step-3 handoff.
 */
import { getDb } from '@altscan/db'
import { sql } from 'drizzle-orm'
import type { ProviderTx, HistoryRow } from '@altscan/providers'

const PAGE = 25

/**
 * Three cursor states. `head` is the live provider page and is the ONLY thing a
 * null or malformed cursor may decode to — see decodeCursor.
 */
export type ServeCursor =
  | { source: 'head' }
  | { source: 'local'; blockNumber: number; txHash: string; logIndex?: number }
  | { source: 'provider'; providerCursor: string }

export function encodeCursor(c: ServeCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

/**
 * Decode defensively. Anything we cannot fully validate becomes `head`, because
 * that is the only state that is always correct: it costs one provider call and
 * shows live data. Guessing `local` from a malformed cursor would serve cached
 * rows where the caller expected live ones.
 */
export function decodeCursor(raw: string | null | undefined): ServeCursor {
  if (!raw) return { source: 'head' }
  try {
    const o: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return { source: 'head' }
    const c = o as Record<string, unknown>

    if (c.source === 'local' && typeof c.blockNumber === 'number' && typeof c.txHash === 'string') {
      // Both halves of the keyset boundary are required — a partial boundary
      // makes the `<` predicate meaningless.
      return typeof c.logIndex === 'number'
        ? { source: 'local', blockNumber: c.blockNumber, txHash: c.txHash, logIndex: c.logIndex }
        : { source: 'local', blockNumber: c.blockNumber, txHash: c.txHash }
    }
    if (c.source === 'provider' && typeof c.providerCursor === 'string' && c.providerCursor) {
      return { source: 'provider', providerCursor: c.providerCursor }
    }
  } catch {
    /* fall through */
  }
  return { source: 'head' }
}

/** Provider tx → the served projection. Drops gas/erc20 rather than carrying
 *  fields the cached path cannot honestly produce. */
export function txToHistoryRow(t: ProviderTx): HistoryRow {
  return {
    hash: t.hash,
    blockNumber: t.blockNumber,
    blockTimestamp: t.blockTimestamp,
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    value: t.value,
    category: t.category,
    summary: t.summary,
    possibleSpam: t.possibleSpam,
  }
}

/** DB row → the same projection. */
function rowToHistoryRow(r: Record<string, unknown>): HistoryRow {
  return {
    hash: String(r.tx_hash),
    blockNumber: String(r.block_number),
    blockTimestamp: new Date(r.block_timestamp as string).toISOString(),
    fromAddress: String(r.from_address),
    toAddress: (r.to_address as string) ?? null,
    value: String(r.value),
    category: (r.category as string) ?? '',
    summary: (r.summary as string) ?? '',
    possibleSpam: Boolean(r.possible_spam),
  }
}

export type BackfillWatermark = {
  status: string
  backfilledThroughBlock: number | null
  /** Where the worker stopped. Step 3 resumes the deep tail from here rather
   *  than re-paging the provider from page one. */
  oldestCursor: string | null
}

export async function readWatermark(
  entityType: string,
  entityId: string,
): Promise<BackfillWatermark | null> {
  const res = await getDb().execute(sql`
    SELECT status, backfilled_through_block, oldest_cursor
    FROM backfill_watermarks
    WHERE entity_type = ${entityType} AND entity_id = ${entityId.toLowerCase()}
    LIMIT 1
  `)
  const row = Array.from(res)[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    status: String(row.status),
    backfilledThroughBlock:
      row.backfilled_through_block == null ? null : Number(row.backfilled_through_block),
    oldestCursor: (row.oldest_cursor as string) ?? null,
  }
}

/** A cached page is only worth offering if the watermark says the worker has
 *  actually written something we can serve. */
export function cacheUsable(wm: BackfillWatermark | null): boolean {
  return !!wm && (wm.status === 'complete' || wm.status === 'capped' || wm.status === 'partial')
}

/** Step 2 probe: does the cache hold anything strictly below the live head's
 *  oldest row? If not, there is nothing to hand off to and we stay on the
 *  provider's own cursor. */
export async function hasLocalRowsBelow(
  address: string,
  blockNumber: number,
  txHash: string,
): Promise<boolean> {
  const res = await getDb().execute(sql`
    SELECT 1 FROM backfill_address_txs
    WHERE address = ${address.toLowerCase()}
      AND (block_number, tx_hash) < (${blockNumber}, ${txHash})
    LIMIT 1
  `)
  return Array.from(res).length > 0
}

/**
 * Step 3: one keyset page strictly below the cursor boundary.
 *
 * Returns the BOUNDARY, not an encoded cursor — the route owns the "what comes
 * after the last local row" decision because that answer depends on the
 * watermark status, which this query has no business knowing.
 */
export async function serveLocalAddressTxs(
  address: string,
  cur: Extract<ServeCursor, { source: 'local' }>,
): Promise<{
  rows: HistoryRow[]
  lastBoundary: { blockNumber: number; txHash: string } | null
  hasMore: boolean
}> {
  const res = await getDb().execute(sql`
    SELECT tx_hash, block_number, block_timestamp, from_address, to_address,
           value, category, summary, possible_spam
    FROM backfill_address_txs
    WHERE address = ${address.toLowerCase()}
      AND (block_number, tx_hash) < (${cur.blockNumber}, ${cur.txHash})
    ORDER BY block_number DESC, tx_hash DESC
    LIMIT ${PAGE + 1}
  `)
  const all = Array.from(res) as Record<string, unknown>[]
  const hasMore = all.length > PAGE
  const page = all.slice(0, PAGE)
  const last = page[page.length - 1]
  return {
    rows: page.map(rowToHistoryRow),
    lastBoundary: last
      ? { blockNumber: Number(last.block_number), txHash: String(last.tx_hash) }
      : null,
    hasMore,
  }
}

/** Boundary that selects the newest cached row — used only by the outage
 *  fallback, where there is no live page to anchor to. Block numbers are ~1e8,
 *  so MAX_SAFE_INTEGER is comfortably above any real value. */
export const TOP_BOUNDARY: Extract<ServeCursor, { source: 'local' }> = {
  source: 'local',
  blockNumber: Number.MAX_SAFE_INTEGER,
  txHash: '0x' + 'f'.repeat(64),
}

// ── Token transfers ────────────────────────────────────────────────────────
//
// Same live-head/cached-tail contract as address txs, but identity is three
// parts: (block_number, tx_hash, log_index). log_index is an INTEGER column, so
// `<` is a numeric comparison and the keyset boundary, the ORDER BY, and the
// natural within-block execution order all agree. (A varchar column would have
// ordered '9' > '10' and made the cursor disagree with its own sort.)

import type { ProviderTokenTransfer, TokenTransferRow } from '@altscan/providers'

/** Provider transfer → the served projection. Drops tokenName, which the
 *  backfill table does not store and the cached path could not honestly fill. */
export function transferToRow(t: ProviderTokenTransfer): TokenTransferRow {
  return {
    txHash: t.txHash,
    logIndex: t.logIndex,
    blockNumber: t.blockNumber,
    blockTimestamp: t.blockTimestamp,
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    tokenAddress: t.tokenAddress,
    tokenSymbol: t.tokenSymbol,
    tokenDecimals: t.tokenDecimals,
    value: t.value,
    valueFormatted: t.valueFormatted,
  }
}

function rowToTransferRow(r: Record<string, unknown>): TokenTransferRow {
  return {
    txHash: String(r.tx_hash),
    logIndex: String(r.log_index),
    blockNumber: String(r.block_number),
    blockTimestamp: new Date(r.block_timestamp as string).toISOString(),
    fromAddress: String(r.from_address),
    toAddress: String(r.to_address),
    tokenAddress: String(r.token_address),
    tokenSymbol: (r.token_symbol as string) ?? '',
    tokenDecimals: r.token_decimals == null ? '0' : String(r.token_decimals),
    value: String(r.value),
    valueFormatted: (r.value_formatted as string) ?? '0',
  }
}

export async function hasLocalTransfersBelow(
  scope: string,
  blockNumber: number,
  txHash: string,
  logIndex: number,
): Promise<boolean> {
  const res = await getDb().execute(sql`
    SELECT 1 FROM backfill_token_transfers
    WHERE scope_address = ${scope.toLowerCase()}
      AND (block_number, tx_hash, log_index) < (${blockNumber}, ${txHash}, ${logIndex})
    LIMIT 1
  `)
  return Array.from(res).length > 0
}

export async function serveLocalTokenTransfers(
  scope: string,
  cur: Extract<ServeCursor, { source: 'local' }>,
): Promise<{
  rows: TokenTransferRow[]
  lastBoundary: { blockNumber: number; txHash: string; logIndex: number } | null
  hasMore: boolean
}> {
  const logIdx = cur.logIndex ?? Number.MAX_SAFE_INTEGER
  const res = await getDb().execute(sql`
    SELECT tx_hash, log_index, block_number, block_timestamp, from_address, to_address,
           token_address, token_symbol, token_decimals, value, value_formatted
    FROM backfill_token_transfers
    WHERE scope_address = ${scope.toLowerCase()}
      AND (block_number, tx_hash, log_index) < (${cur.blockNumber}, ${cur.txHash}, ${logIdx})
    ORDER BY block_number DESC, tx_hash DESC, log_index DESC
    LIMIT ${PAGE + 1}
  `)
  const all = Array.from(res) as Record<string, unknown>[]
  const hasMore = all.length > PAGE
  const page = all.slice(0, PAGE)
  const last = page[page.length - 1]
  return {
    rows: page.map(rowToTransferRow),
    lastBoundary: last
      ? {
          blockNumber: Number(last.block_number),
          txHash: String(last.tx_hash),
          logIndex: Number(last.log_index),
        }
      : null,
    hasMore,
  }
}

/** Top-of-cache boundary for transfers (outage fallback only). */
export const TOP_TRANSFER_BOUNDARY: Extract<ServeCursor, { source: 'local' }> = {
  ...TOP_BOUNDARY,
  logIndex: Number.MAX_SAFE_INTEGER,
}
