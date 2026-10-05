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

/** Count in the "Transactions (…)" heading: `12`, `50 of 141` on a capped page 1, `51–100 of 141` after it. */
export function txsLabel(page: number, shown: number, txCount: number): string {
  if (page === 1) {
    return shown === BLOCK_TXS_PER_PAGE && txCount > shown ? `${shown} of ${formatNumber(txCount)}` : `${shown}`
  }
  if (shown === 0) return `0 of ${formatNumber(txCount)}`
  const first = (page - 1) * BLOCK_TXS_PER_PAGE + 1
  return `${formatNumber(first)}–${formatNumber(first + shown - 1)} of ${formatNumber(txCount)}`
}
