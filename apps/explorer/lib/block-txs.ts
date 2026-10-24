import { formatNumber } from '@/lib/format'

/** Transactions listed per page on a block page. */
export const BLOCK_TXS_PER_PAGE = 50

/**
 * The `[page]` segment of /blocks/<n>/txs/<page>: an integer >= 2, else null. Page 1 is
 * /blocks/<n> itself, so `1` is not a page here, and neither are `02`, `2.5` or `1e1`
 * (each would be a second URL for a page that already has one).
 */
export function parseTxsPage(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null
  const page = Number(raw)
  return Number.isSafeInteger(page) && page >= 2 ? page : null
}

/** Pages needed for `txCount` transactions; an empty block still has its one page. */
export function txsPageCount(txCount: number): number {
  return Math.max(1, Math.ceil(txCount / BLOCK_TXS_PER_PAGE))
}

/**
 * Whether /blocks/<n>/txs/<page> is a real page. Page 1 is the block page itself; later pages page
 * through our own rows, so they need the block in the DB (an RPC block has none) and enough transactions.
 */
export function pageExists(page: number, dbBlockPresent: boolean, txCount: number): boolean {
  return page === 1 || (dbBlockPresent && page <= txsPageCount(txCount))
}

/** Page 1 is the block's canonical URL; later pages are a path segment, not `?page=`, so the route stays static. */
export function blockTxsHref(blockNumber: number, page: number): string {
  return page === 1 ? `/blocks/${blockNumber}` : `/blocks/${blockNumber}/txs/${page}`
}

/**
 * Count in the "Transactions (…)" heading: `12`, `50 of 141` on a capped page 1, `51–100 of 141` after it.
 * A short page 1 of a block that claims more (`40 of 141`) is rows not indexed: a bare `40` would read as all of them.
 */
export function txsLabel(page: number, shown: number, txCount: number): string {
  if (page === 1) {
    return txCount > shown ? `${shown} of ${formatNumber(txCount)}` : `${shown}`
  }
  if (shown === 0) return `0 of ${formatNumber(txCount)}`
  const first = (page - 1) * BLOCK_TXS_PER_PAGE + 1
  return `${formatNumber(first)}–${formatNumber(first + shown - 1)} of ${formatNumber(txCount)}`
}

/** Rows a page lists when every one of the block's `txCount` transactions is indexed. */
export function expectedOnPage(page: number, txCount: number): number {
  return Math.max(0, Math.min(BLOCK_TXS_PER_PAGE, txCount - (page - 1) * BLOCK_TXS_PER_PAGE))
}

/**
 * The table lists indexed rows, but the totals (the heading, the ledger tile, the page count) come from the block's own
 * `tx_count`. When a page lists fewer rows than that count implies, say so rather than let the table pass for the whole
 * block. Null when the page is complete.
 */
export function indexedNote(page: number, shown: number, txCount: number): string | null {
  const expected = expectedOnPage(page, txCount)
  if (shown >= expected) return null
  return page === 1 && txCount <= BLOCK_TXS_PER_PAGE
    ? `${shown} of ${formatNumber(txCount)} transactions indexed. The rest are not listed here.`
    : `${shown} of ${expected} transactions on this page indexed. The rest are not listed here.`
}
