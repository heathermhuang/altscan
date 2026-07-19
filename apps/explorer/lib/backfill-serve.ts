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
 * O1 — the live/local seam ordering contract.
 *
 * Moralis is never asked for a sort order; the local keyset orders by
 * (block_number, tx_hash) DESC. Cross-block the provider is block-DESC, but
 * WITHIN the boundary block (the block holding the live page's oldest row)
 * provider order ≠ hash order, so a tuple cursor anchored at the oldest row
 * both skips boundary-block rows the provider happened not to serve (hash
 * above the anchor) and re-serves ones it did (hash below it). Block-exclusive
 * handoff is not an option either: a fixed page size MUST split any block
 * holding more same-address rows than one page (airdrops, MEV bots), so its
 * boundary-block rows would be dropped outright.
 *
 * The exact fix: the handoff cursor anchors at (boundaryBlock, TOP_HASH) —
 * i.e. "everything at or below the boundary block" — and carries the hashes
 * the live page already served IN that block as an exclusion list. The
 * exclusion must KEEP riding the cursor while local pagination remains inside
 * the boundary block (excluding only on the first local page re-serves a seen
 * row one page later, when the keyset descends past its hash); once the
 * keyset moves below the boundary block the fields are dropped — see
 * carrySeamExclusions.
 */

/**
 * Ceiling on carried exclusions. A live page cannot contribute more rows than
 * it holds (25 today, ≤100 for any plausible provider page), so anything
 * larger is a forged cursor; and the mint side skips the handoff instead of
 * exceeding it — the provider's own cursor is always a correct fallback.
 */
export const SEEN_CAP = 100

/** Lexical top for VARCHAR(66) hash columns — no real hash sorts at or above
 *  it, so `(block, hash) < (B, TOP_HASH)` reads "every row of block B". */
export const TOP_HASH = '0x' + 'f'.repeat(64)

/**
 * Top sentinel for the INTEGER log_index column — int4 max, NOT
 * Number.MAX_SAFE_INTEGER: a parameter beyond int4 range makes Postgres throw
 * 22003 (numeric_value_out_of_range) on the row-value comparison, observed
 * live against PG 16. Every cursor logIndex must stay inside this domain.
 */
export const TOP_LOG_INDEX = 0x7fffffff

const HASH_RE = /^0x[0-9a-fA-F]{1,64}$/

/**
 * Three cursor states. `head` is the live provider page and is the ONLY thing a
 * null or malformed cursor may decode to — see decodeCursor.
 */
export type ServeCursor =
  | { source: 'head' }
  | {
      source: 'local'
      blockNumber: number
      txHash: string
      logIndex?: number
      /** O1 seam carry: the handoff block whose provider-served rows are
       *  excluded below. Present only while the keyset is inside that block. */
      boundaryBlock?: number
      /** Address-txs exclusions: tx hashes the live page served in
       *  boundaryBlock. Stored lowercase; compared exactly. */
      seenTxHashes?: string[]
      /** Transfer exclusions: (tx_hash, log_index) pairs — hash alone would
       *  also drop UNSEEN sibling transfers of the same transaction. */
      seenTransferKeys?: { h: string; i: number }[]
    }
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

    if (c.source === 'local') {
      // These cursors are NOT unforgeable — anyone can base64url a payload and
      // reach the cached path. That is acceptable (the address comes from the
      // route path, never the cursor, so no cross-entity access is possible and
      // the rows are the same ones the caller could already read), but it does
      // mean every field must be validated as if hostile: a non-finite or
      // negative blockNumber, or a non-hex txHash, would otherwise reach the
      // keyset predicate directly.
      const blk = c.blockNumber
      const hash = c.txHash
      if (!Number.isSafeInteger(blk) || (blk as number) < 0) return { source: 'head' }
      if (typeof hash !== 'string' || !HASH_RE.test(hash)) return { source: 'head' }
      const base: Extract<ServeCursor, { source: 'local' }> = {
        source: 'local',
        blockNumber: blk as number,
        txHash: hash,
      }
      if (c.logIndex !== undefined) {
        // Bounded to the int4 column domain — see TOP_LOG_INDEX.
        if (
          !Number.isSafeInteger(c.logIndex) ||
          (c.logIndex as number) < 0 ||
          (c.logIndex as number) > TOP_LOG_INDEX
        ) {
          return { source: 'head' }
        }
        base.logIndex = c.logIndex as number
      }

      // O1 seam fields — all-or-nothing: a boundary block plus EXACTLY ONE
      // non-empty exclusion list (we never mint both kinds on one cursor).
      // Anything malformed falls back to head like every other invalid cursor.
      const hasSeam =
        c.boundaryBlock !== undefined ||
        c.seenTxHashes !== undefined ||
        c.seenTransferKeys !== undefined
      if (!hasSeam) return base
      if (!Number.isSafeInteger(c.boundaryBlock) || (c.boundaryBlock as number) < 0) {
        return { source: 'head' }
      }
      const rawHashes = c.seenTxHashes
      const rawKeys = c.seenTransferKeys
      if ((rawHashes === undefined) === (rawKeys === undefined)) return { source: 'head' }
      base.boundaryBlock = c.boundaryBlock as number
      if (rawHashes !== undefined) {
        if (!Array.isArray(rawHashes) || rawHashes.length === 0 || rawHashes.length > SEEN_CAP) {
          return { source: 'head' }
        }
        const seen: string[] = []
        for (const h of rawHashes) {
          if (typeof h !== 'string' || !HASH_RE.test(h)) return { source: 'head' }
          seen.push(h.toLowerCase())
        }
        base.seenTxHashes = seen
      } else {
        if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.length > SEEN_CAP) {
          return { source: 'head' }
        }
        const seen: { h: string; i: number }[] = []
        for (const k of rawKeys) {
          if (typeof k !== 'object' || k === null || Array.isArray(k)) return { source: 'head' }
          const { h, i } = k as Record<string, unknown>
          if (typeof h !== 'string' || !HASH_RE.test(h)) return { source: 'head' }
          if (!Number.isSafeInteger(i) || (i as number) < 0 || (i as number) > TOP_LOG_INDEX) {
            return { source: 'head' }
          }
          seen.push({ h: h.toLowerCase(), i: i as number })
        }
        base.seenTransferKeys = seen
      }
      return base
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

/**
 * Step 2 gate: may we hand pagination off to the cache after this live page?
 *
 * ONLY IF THE CACHE IS CONTIGUOUS WITH THE HEAD. Testing "does the cache hold
 * anything below page 1's oldest row" is NOT sufficient and silently loses
 * data: if activity arrived after the last backfill run, the cache's newest row
 * sits well below the live head, and jumping to it skips every transaction in
 * between. (Backfill at 100 txs, then 60 new ones arrive: page 1 shows txs
 * 1-25, the cache starts at tx 61, and txs 26-60 disappear from the UI with no
 * error anywhere.)
 *
 * Contiguity proof: the cache must contain at least one row at or above the
 * live page's oldest block. Then there is no gap between what the provider just
 * served and what the cache can serve next.
 */
export async function cacheCoversFrom(address: string, oldestBlock: number): Promise<boolean> {
  const res = await getDb().execute(sql`
    SELECT 1 FROM backfill_address_txs
    WHERE address = ${address.toLowerCase()}
      AND block_number >= ${oldestBlock}
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
  // O1: subtract the boundary-block rows the live page already served. Applies
  // only to rows of boundaryBlock, so the filter vanishes naturally once the
  // keyset descends past it (and the route stops carrying the fields).
  const seamFilter =
    cur.boundaryBlock !== undefined && cur.seenTxHashes && cur.seenTxHashes.length > 0
      ? sql` AND NOT (block_number = ${cur.boundaryBlock} AND tx_hash IN (${sql.join(
          cur.seenTxHashes.map(h => sql`${h}`),
          sql`, `,
        )}))`
      : sql.raw('')
  const res = await getDb().execute(sql`
    SELECT tx_hash, block_number, block_timestamp, from_address, to_address,
           value, category, summary, possible_spam
    FROM backfill_address_txs
    WHERE address = ${address.toLowerCase()}
      AND (block_number, tx_hash) < (${cur.blockNumber}, ${cur.txHash})${seamFilter}
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
  txHash: TOP_HASH,
}

/**
 * O1: which seam fields (if any) the NEXT local cursor must carry.
 *
 * While the page ends inside the boundary block, the exclusion list must ride
 * along — the next tuple boundary sits below some seen hashes, and without the
 * list they would be re-served as duplicates. The moment the keyset descends
 * past the boundary block, every one of its rows is accounted for (served or
 * excluded) and the fields are dropped for good.
 */
export function carrySeamExclusions(
  cur: Extract<ServeCursor, { source: 'local' }>,
  lastBoundaryBlock: number,
): Partial<
  Pick<
    Extract<ServeCursor, { source: 'local' }>,
    'boundaryBlock' | 'seenTxHashes' | 'seenTransferKeys'
  >
> {
  if (cur.boundaryBlock === undefined || lastBoundaryBlock !== cur.boundaryBlock) return {}
  const out: ReturnType<typeof carrySeamExclusions> = { boundaryBlock: cur.boundaryBlock }
  if (cur.seenTxHashes && cur.seenTxHashes.length > 0) out.seenTxHashes = cur.seenTxHashes
  if (cur.seenTransferKeys && cur.seenTransferKeys.length > 0) {
    out.seenTransferKeys = cur.seenTransferKeys
  }
  return out
}

/** O1 mint-side: the live page's tx hashes inside the boundary block,
 *  lowercased to match how the worker stores provider hashes. */
export function collectSeenTxHashes(rows: HistoryRow[], boundaryBlock: number): string[] {
  return rows
    .filter(r => Number(r.blockNumber) === boundaryBlock)
    .map(r => r.hash.toLowerCase())
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

/** Transfers equivalent of cacheCoversFrom — same contiguity requirement. */
export async function transferCacheCoversFrom(scope: string, oldestBlock: number): Promise<boolean> {
  const res = await getDb().execute(sql`
    SELECT 1 FROM backfill_token_transfers
    WHERE scope_address = ${scope.toLowerCase()}
      AND block_number >= ${oldestBlock}
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
  const logIdx = cur.logIndex ?? TOP_LOG_INDEX
  // O1: pair-precise exclusion — see serveLocalAddressTxs. Pairs, not hashes:
  // one transaction can carry many transfers, and excluding by hash alone
  // would drop the UNSEEN siblings of a seen transfer.
  const seamFilter =
    cur.boundaryBlock !== undefined && cur.seenTransferKeys && cur.seenTransferKeys.length > 0
      ? sql` AND NOT (block_number = ${cur.boundaryBlock} AND (tx_hash, log_index) IN (${sql.join(
          cur.seenTransferKeys.map(k => sql`(${k.h}, ${k.i})`),
          sql`, `,
        )}))`
      : sql.raw('')
  const res = await getDb().execute(sql`
    SELECT tx_hash, log_index, block_number, block_timestamp, from_address, to_address,
           token_address, token_symbol, token_decimals, value, value_formatted
    FROM backfill_token_transfers
    WHERE scope_address = ${scope.toLowerCase()}
      AND (block_number, tx_hash, log_index) < (${cur.blockNumber}, ${cur.txHash}, ${logIdx})${seamFilter}
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

/** Top-of-cache boundary for transfers (outage fallback only). Its logIndex
 *  MUST be TOP_LOG_INDEX — the MAX_SAFE_INTEGER it originally carried threw
 *  22003 on the int4 log_index comparison, which would have 500'd the outage
 *  fallback the first time it ran. Caught by backfill-serve.pg.test.ts. */
export const TOP_TRANSFER_BOUNDARY: Extract<ServeCursor, { source: 'local' }> = {
  ...TOP_BOUNDARY,
  logIndex: TOP_LOG_INDEX,
}

/**
 * O1 mint-side for transfers: (hash, logIndex) pairs of the live page's
 * boundary-block rows. A transfer whose logIndex is null/empty/non-numeric is
 * dropped rather than coerced — such a row cannot exist in the cache anyway
 * (log_index is NOT NULL and part of the PK), so nothing cached can collide
 * with it and excluding it would only risk dropping a real (hash, 0) row via
 * a fabricated index. The A4b-2 worker must uphold the same reading: skip
 * provider rows with a null log_index instead of inventing one.
 */
export function collectSeenTransferKeys(
  rows: TokenTransferRow[],
  boundaryBlock: number,
): { h: string; i: number }[] {
  const keys: { h: string; i: number }[] = []
  for (const t of rows) {
    if (Number(t.blockNumber) !== boundaryBlock) continue
    if (t.logIndex == null || t.logIndex === '') continue
    const i = Number(t.logIndex)
    if (!Number.isSafeInteger(i) || i < 0) continue
    keys.push({ h: t.txHash.toLowerCase(), i })
  }
  return keys
}
