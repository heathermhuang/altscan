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
 *
 * WHY suggestQuery IS TWO BOUNDED ARMS, NOT `WHERE lower(symbol) LIKE p ORDER BY holder_count DESC LIMIT 50`.
 * That plain query has two plans, and which one Postgres picks rides on its row estimate for the prefix:
 * read the symbol index (cost grows with the MATCHES) or walk tokens_holder_count_idx from the top and
 * filter (cost grows with the rows passed before 50 match). The estimate for a prefix narrower than a
 * histogram bucket is a fraction of a bucket, whatever the truth, so on a 1.9M-row table 31 of the 4,096
 * three-letter prefixes chose the walk, each took 150 ms to 1.0 s, and a prefix with under 50 matches
 * walks the whole table. The arms below cannot: the first reads 5,000 rows, always; the second reads 300 in
 * index order, or, when the planner expects only a few matches, fetches and sorts them all, which is bounded by
 * the one histogram bucket (~1% of the table) its estimate came from. Neither ever walks the table.
 */
import { or, sql } from 'drizzle-orm'
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

/** Arm 1 reads this many of the most-held tokens and keeps those matching the prefix: every well-known token. */
export const SUGGEST_POPULAR_ROWS = 5000
/** Arm 2 reads this many matches in symbol order: every match of a prefix long enough to be rare. */
export const SUGGEST_PREFIX_ROWS = 300

/**
 * Candidates for the prefix, most-held first, plain DESC like /search (the column is NOT NULL). `prefix` comes
 * from suggestPrefix. Two arms, each bounded, unioned (see the module comment):
 *  - popular: the 5,000 most-held tokens, filtered. A subquery with its own LIMIT cannot be flattened, so this
 *    is always the holder_count walk, stopped at 5,000 rows (~3 ms). It finds the real USDT among thousands of
 *    USDT-named copies, which the arm below cannot (it reads them in no useful order).
 *  - by prefix: `ORDER BY lower(symbol) USING ~<~` is the text_pattern_ops index's own order, so it is read
 *    straight off tokens_lower_symbol_idx and stopped at 300 matches. It finds a rare, low-holder ticker.
 * No prefix reads more than 5,000 + 300 rows when the planner expects many matches (it reads the second arm in
 * index order and stops), or 5,000 + the few it expected (a bitmap scan and a sort of at most one histogram bucket).
 */
export function suggestQuery(prefix: string) {
  const like = likePrefixPattern(prefix)
  return sql`
    SELECT address, symbol, name, holder_count FROM (
      (SELECT address, symbol, name, holder_count
         FROM (SELECT address, symbol, name, holder_count FROM tokens ORDER BY holder_count DESC LIMIT ${sql.raw(String(SUGGEST_POPULAR_ROWS))}) popular
        WHERE lower(symbol) LIKE ${like})
      UNION
      (SELECT address, symbol, name, holder_count FROM tokens
        WHERE lower(symbol) LIKE ${like}
        ORDER BY lower(symbol) USING ~<~ LIMIT ${sql.raw(String(SUGGEST_PREFIX_ROWS))})
    ) matches
    ORDER BY holder_count DESC LIMIT ${sql.raw(String(SUGGEST_CANDIDATES))}`
}

/**
 * How long the typeahead's query may run. The route waits this long (withTimeout), and the SERVER cancels the
 * statement at the same mark (withStatementTimeout), so a request the visitor has been told is over is not still
 * running.
 */
export const SUGGEST_TIMEOUT_MS = 1500

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Run `run` in a transaction whose statements the database cancels after `ms` (SQLSTATE 57014, and the
 * transaction rolls back). withTimeout only stops WAITING: the query itself keeps running on the server and
 * holds one of the web service's few pooled connections (DB_POOL_SIZE, 5) until it finishes, so a burst of
 * requests during a slowdown piles up abandoned queries and delays unrelated pages. `SET LOCAL` lasts for this
 * transaction only, so the pool's other statements keep the service's own (opt-in) limit.
 */
export async function withStatementTimeout<T>(db: Db, ms: number, run: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isInteger(ms) || ms <= 0) throw new RangeError(`statement timeout must be a positive whole number of ms, got ${ms}`)
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${ms}ms'`)) // SET takes no bind parameters; ms is an integer
    return run(tx)
  })
}

/** suggestQuery's rows, in the shape rankTokenMatches reads. */
export async function suggestRows(db: Db, prefix: string, timeoutMs: number = SUGGEST_TIMEOUT_MS) {
  const rows = await withStatementTimeout(db, timeoutMs, (tx) => tx.execute(suggestQuery(prefix)))
  return Array.from(rows, (r) => ({
    address: String(r.address), symbol: String(r.symbol), name: String(r.name), holderCount: Number(r.holder_count),
  }))
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
  const imitates = (t: { address: string; symbol: string; name: string }) => lookalikeOf(t, chain)?.symbol ?? null
  return rankTokenMatches(rows, prefix, (t) => imitates(t) !== null, SUGGEST_LIMIT).map((t) => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    holders: t.holderCount,
    lookalikeOf: imitates(t),
  }))
}
