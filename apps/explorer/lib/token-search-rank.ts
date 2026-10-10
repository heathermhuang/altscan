/**
 * Rank /search token candidates. The SQL only finds rows that CONTAIN the query; which of them a
 * visitor should see first is decided here, pure, so it is unit-testable without a database:
 * every real token before every lookalike (flagged impersonators), whatever their match tier: a
 * lookalike NAMED "Tether" is an exact-name match and the canonical "Tether USD" only a name-prefix
 * one, so ranking real tokens first only inside a tier let it outrank the real contract. Then, in each
 * class: exact symbol → exact name → symbol prefix → name prefix → contains (all case-insensitive),
 * then more holders first, then address (a stable order when counts tie, so renders don't reshuffle).
 */

type Candidate = { address: string; name: string; symbol: string; holderCount: number }

/** Rows the page asks the database for, already ordered by holder count. */
export const SEARCH_CANDIDATE_LIMIT = 50
/** Rows the page shows. */
export const SEARCH_RESULT_LIMIT = 10

function tierOf(token: Candidate, q: string): number {
  const symbol = token.symbol.trim().toLowerCase()
  const name = token.name.trim().toLowerCase()
  if (symbol === q) return 0
  if (name === q) return 1
  if (symbol.startsWith(q)) return 2
  if (name.startsWith(q)) return 3
  return 4
}

export function rankTokenMatches<T extends Candidate>(
  tokens: readonly T[],
  query: string,
  isLookalike: (token: T) => boolean,
  limit: number = SEARCH_RESULT_LIMIT,
): T[] {
  const q = query.trim().toLowerCase()
  return tokens
    .map((token) => ({ token, tier: tierOf(token, q), fake: isLookalike(token) ? 1 : 0 }))
    .sort((a, b) =>
      a.fake - b.fake
      || a.tier - b.tier
      || b.token.holderCount - a.token.holderCount
      || (a.token.address < b.token.address ? -1 : a.token.address > b.token.address ? 1 : 0))
    .slice(0, limit)
    .map((r) => r.token)
}
