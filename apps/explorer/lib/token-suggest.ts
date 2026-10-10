/**
 * The two token lookups that tokens_lower_symbol_idx / tokens_lower_name_idx (lower(col) text_pattern_ops) serve:
 *  - suggestQuery: token suggestions for the header search box (GET /api/search/suggest), the most-held
 *    tokens whose symbol STARTS with what the visitor has typed;
 *  - exactMatchQuery: the tokens whose symbol or name EQUALS a /search query, so an exact ticker is never
 *    missed because 50 better-held tokens merely contain it.
 *
 * `lower(symbol) LIKE 'prefix%'` is served by tokens_lower_symbol_idx (lower(symbol) text_pattern_ops):
 * the database collation is not C, so a plain index could not answer a prefix LIKE, and the pattern has
 * to be a constant when the query is planned. It is: drizzle's postgres-js driver sends every statement
 * unprepared, so each execution is planned with its parameter values (token-suggest.pg.test.ts proves
 * it through that driver). Do not switch these queries to named prepared statements.
 */
import { desc, or, sql } from 'drizzle-orm'
import { schema, type Db } from '@altscan/db'
import type { ChainKey } from '@altscan/chain-config'
import { lookalikeOf } from '@/lib/lookalike'
import { rankTokenMatches, SEARCH_CANDIDATE_LIMIT } from '@/lib/token-search-rank'
import { SUGGEST_MAX_CHARS, SUGGEST_MIN_CHARS, type TokenSuggestion } from '@/lib/search-suggest'

/** Suggestions shown. */
export const SUGGEST_LIMIT = 5
/**
 * Rows read before ranking: the depth /search reads, so both put the same real token first. Holders alone
 * would show five lookalikes of a stablecoin (several out-hold the real contract); ranking real before
 * lookalike over a wider set lets the real token surface.
 */
export const SUGGEST_CANDIDATES = SEARCH_CANDIDATE_LIMIT
/** The lowercased, trimmed prefix to look up, or null when the text cannot be a suggestion query. */
export function suggestPrefix(raw: string | null): string | null {
  const q = raw?.trim().toLowerCase() ?? ''
  if (q.length < SUGGEST_MIN_CHARS || q.length > SUGGEST_MAX_CHARS || q.includes('\u0000')) return null
  return q
}

/** `prefix%` as a LIKE pattern, the visitor's % _ and \ matched literally (backslash is LIKE's default escape). */
export function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[%_\\]/g, '\\$&')}%`
}

/**
 * Plain DESC on holder_count, like /search: the column is NOT NULL, and NULLS LAST would not match the
 * holder_count index. `prefix` comes from suggestPrefix.
 */
export function suggestQuery(db: Db, prefix: string) {
  const t = schema.tokens
  return db
    .select({ address: t.address, symbol: t.symbol, name: t.name, holderCount: t.holderCount })
    .from(t)
    .where(sql`lower(${t.symbol}) like ${likePrefixPattern(prefix)}`)
    .orderBy(desc(t.holderCount))
    .limit(SUGGEST_CANDIDATES)
}

/**
 * Rows whose lower(symbol) or lower(name) equals `q` (already lowercased), whatever their holder count.
 *
 * Deliberately NO ORDER BY: for a common value ('???', 'Unknown') the planner would walk
 * tokens_holder_count_idx across every better-held token to reach the junk (measured: 2.0 s for 10 rows on
 * 1.9M tokens, against 0.04 ms unordered). The ten rows are therefore not the best-held ten, and don't need
 * to be: /search unions them with its by-holders candidates, which are.
 */
export function exactMatchQuery(db: Db, q: string, limit: number) {
  const t = schema.tokens
  return db.select().from(t)
    .where(or(sql`lower(${t.symbol}) = ${q}`, sql`lower(${t.name}) = ${q}`))
    .limit(limit)
}

/** Rank the candidates as /search does (real before lookalike, exact symbol first, then holders) and cut to five. */
export function shapeSuggestions(
  rows: readonly { address: string; symbol: string; name: string; holderCount: number }[],
  prefix: string,
  chain: ChainKey,
): TokenSuggestion[] {
  const lookalike = (t: { address: string; symbol: string; name: string }) => lookalikeOf(t, chain) !== null
  return rankTokenMatches(rows, prefix, lookalike, SUGGEST_LIMIT).map((t) => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    holders: t.holderCount,
    lookalike: lookalike(t),
  }))
}
