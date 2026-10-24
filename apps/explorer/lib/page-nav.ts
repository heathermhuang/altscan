import { formatNumber } from '@/lib/format'
import { MAX_LIST_ROWS, lastListPage } from '@/lib/list-depth'

export type PageNav = { label: string; hasPrev: boolean; hasNext: boolean }

/**
 * What <Pagination> prints and links, as pure data. Null when there is nothing to page through.
 *
 * Two honesty rules, because `total` on the lists is an estimate (a `pg_class` row count), not a count:
 *   - The depth-limited lists hand over `Math.min(total, MAX_LIST_ROWS)`, so a total of exactly MAX_LIST_ROWS means
 *     "at least this many": the last page is the 400th the list serves (lib/list-depth.ts), not the end of the data, and
 *     reads "of 400+".
 *   - The estimate can be behind the table (0 on one that was never analysed). `rowsOnPage` is how many rows the caller
 *     rendered; a FULL page holding more rows than the estimate allows for that page proves the estimate is behind and
 *     that more may follow, so offer the next link and drop the "of N" it contradicts. A full last page the estimate
 *     does account for (50 rows, page 2 of 25) proves nothing and keeps the estimate's word. Callers that do not pass
 *     it keep the estimate as the whole story.
 */
export function pageNav(opts: { page: number; total: number; perPage: number; rowsOnPage?: number }): PageNav | null {
  const { page, total, perPage, rowsOnPage } = opts
  const lastServed = lastListPage(perPage)
  const capped = total === MAX_LIST_ROWS
  const totalPages = capped ? lastServed : Math.ceil(total / perPage)
  const estimated = Math.max(0, Math.min(perPage, total - (page - 1) * perPage))
  const beyondEstimate = rowsOnPage !== undefined && rowsOnPage >= perPage && rowsOnPage > estimated && page < lastServed
  // A page past the estimate's last one (reached through a next link the rule above offered) disproves the
  // estimate as much as a full page does: it never gets the "of N" back, and it always keeps the way back.
  const pastEstimate = page > totalPages
  if (page <= 1 && totalPages <= 1 && !beyondEstimate) return null
  return {
    hasPrev: page > 1,
    hasNext: beyondEstimate || (!pastEstimate && page < totalPages),
    label: beyondEstimate || pastEstimate
      ? `Page ${formatNumber(page)}`
      : `Page ${formatNumber(page)} of ${formatNumber(totalPages)}${capped ? '+' : ''}`,
  }
}
