/**
 * Where a search-box query goes: a block, a tx, an address, or the token search page.
 * Pure so the box (components/layout/SearchBar.tsx), the /search page and their tests share one definition.
 */

/** Longest query that is looked at; the rest is dropped before anything is matched against it. */
export const SEARCH_QUERY_MAX = 200

/**
 * Turn what a visitor pasted into the form the router understands:
 *  - trim, and strip one leading "#" ("#125761128" is a block, "#cake" a search for cake);
 *  - inside an all-digit query, drop "," space and "_" ("125,761,128" is how block explorers print a number);
 *  - lowercase a "0X" prefix, and add the "0x" a bare 40- or 64-hex string (address, tx hash) is missing.
 * Hex keeps its case otherwise (addresses are checksummed). An all-digit string is never taken for hex:
 * a 40-digit number is a block.
 */
export function normaliseSearchQuery(raw: string): string {
  // Capped FIRST, before any regex sees it: this runs per request on /search (dynamic, not rate limited) and per
  // keystroke in the box, and no search is longer than a symbol, a name, an address or a hash.
  let q = raw.slice(0, SEARCH_QUERY_MAX).trim()
  if (q.startsWith('#')) q = q.slice(1).trim()
  // Two linear tests, not one /^[\d,\s_]*\d[\d,\s_]*$/: that backtracks quadratically on a long digit run that
  // fails at the end (16,000 digits and an 'x' took ~150 ms).
  if (/^[\d,\s_]+$/.test(q) && /\d/.test(q)) return q.replace(/[,\s_]/g, '')
  if (q.startsWith('0X')) q = `0x${q.slice(2)}`
  if (/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(q)) return `0x${q}`
  return q
}

export type QueryKind = 'block' | 'tx' | 'address' | 'text'

/** What a query opens, and the normalised text it opens it with. */
export function classifyQuery(raw: string): { kind: QueryKind; q: string } {
  const q = normaliseSearchQuery(raw)
  if (/^\d+$/.test(q)) return { kind: 'block', q }
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { kind: 'tx', q }
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: 'address', q }
  return { kind: 'text', q }
}

export function routeForQuery(raw: string): string | null {
  const { kind, q } = classifyQuery(raw)
  if (!q) return null
  if (kind === 'block') return `/blocks/${q}`
  if (kind === 'tx') return `/tx/${q}`
  if (kind === 'address') return `/address/${q}`
  return `/search?q=${encodeURIComponent(q)}`
}
