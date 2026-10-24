/**
 * How deep the explorer's newest-first lists go: the newest 10,000 rows, as the token
 * page's transfer list already does (TOKEN_TRANSFERS_MAX_ROWS) and POST /api/v1/query's
 * MAX_OFFSET allows.
 *
 * Every page reads every row before it: OFFSET n makes Postgres walk and discard n rows,
 * so without a cap `?page=` sets the cost of the query, and each distinct page number is
 * its own cache entry. Older rows stay reachable by hash, block, address or a block-range
 * query.
 */
export const MAX_LIST_ROWS = 10_000

/** The deepest page a list of `perPage` rows serves: 400 at 25 a page. */
export function lastListPage(perPage: number): number {
  return Math.max(1, Math.floor(MAX_LIST_ROWS / perPage))
}

/** A page number for a newest-first list, clamped to the pages it serves. */
export function clampListPage(page: number, perPage: number): number {
  return Math.min(lastListPage(perPage), Math.max(1, page))
}

/**
 * page/limit for the public list endpoints. Non-numbers (and Infinity) are refused;
 * fractions are floored and `limit` is clamped to 1-50, as documented. A page that
 * starts beyond the newest MAX_LIST_ROWS rows is refused rather than scanned.
 */
export function apiListPage(params: URLSearchParams): { page: number; limit: number; offset: number } | { error: string } {
  const rawPage = Number(params.get('page') ?? 1)
  const rawLimit = Number(params.get('limit') ?? 20)
  if (!Number.isFinite(rawPage) || !Number.isFinite(rawLimit)) return { error: 'Invalid pagination parameters' }
  const page = Math.max(1, Math.floor(rawPage))
  const limit = Math.min(50, Math.max(1, Math.floor(rawLimit)))
  const offset = (page - 1) * limit
  if (offset >= MAX_LIST_ROWS) {
    return {
      error: `page ${page} starts beyond the newest ${MAX_LIST_ROWS} records; for older data use POST /api/v1/query with filter.blockFrom/blockTo`,
    }
  }
  return { page, limit, offset }
}
