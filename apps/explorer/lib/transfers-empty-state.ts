/**
 * What the token page's transfers table says when it has no rows to show.
 *
 * "No transfers yet." is a CLAIM about the token, so it is only for a query that succeeded and found nothing. A query that
 * failed or timed out (`rows` null) says nothing about the token, and neither does an empty page when the count says there
 * are rows at this offset: both read "temporarily unavailable". An empty page BEYOND the last row (a ?page= past the end) is a
 * plain empty page.
 *
 * @param rows   the page's rows; null = the query failed or timed out
 * @param count  how many transfers the count query found (capped by the list's depth); -1 = unknown (it failed or timed out)
 * @param offset the first row index this page asks for
 */
export type TransfersState = 'rows' | 'none' | 'unavailable'

export function transfersEmptyState(o: { rows: readonly unknown[] | null; count: number; offset: number }): TransfersState {
  if (o.rows === null) return 'unavailable'
  if (o.rows.length > 0) return 'rows'
  return o.count > o.offset ? 'unavailable' : 'none'
}

/** The table's single row of text for a state with no rows. */
export const TRANSFERS_EMPTY_TEXT: Record<Exclude<TransfersState, 'rows'>, string> = {
  none: 'No transfers yet.',
  unavailable: 'Transfers are temporarily unavailable. Try again shortly.',
}
