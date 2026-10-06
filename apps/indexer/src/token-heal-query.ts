/**
 * The SQL the token-metadata healer pages through, as pure builders so a test can
 * render and pin it for each chain. The healer owns the I/O; the decisions about
 * WHICH row comes next live in token-metadata.ts.
 */
import { and, desc, gte, ne, or, sql, type SQL } from 'drizzle-orm'
import type { ChainKey } from '@altscan/chain-config'
import { schema } from './db'
import { UNKNOWN_NAME, UNKNOWN_SYMBOL, type HealCursor } from './token-metadata'

const { tokens } = schema

/** Holders at which an ETH placeholder with zero supply is a candidate again (see healCandidatePredicate). */
export const ETH_ZERO_SUPPLY_MIN_HOLDERS = 2

/**
 * Which `tokens` rows are worth an RPC call to heal.
 *
 * BNB: a placeholder name or symbol, or a zero supply on a BEP20.
 *
 * ETH: a placeholder name or symbol, EXCEPT a zero-supply row nobody holds. The
 * stock of those is junk. Measured against production on 2026-10-06, a direct RPC
 * probe of 33 random rows per bucket found 0/33 healable for placeholder+zero-supply
 * (105,967 rows at 0 holders, 40,438 at 1 holder; none of ~2,000 logged attempts
 * healed either) and 0/33 for the 1-holder placeholders, against 10/33 for
 * placeholders that DO have a non-zero supply (9,362 rows at 0 holders, 19 above
 * that — NFT collections whose name() answers). Left in, those 146k rows fill the
 * candidate list ahead of everything healable, and the healer logged `tried 40,
 * healed 0` on every run.
 *
 * But the first-sight fetch stores Unknown / ??? / supply 0 for ANY token whose
 * fetch was throttled, junk or not, so a fresh real token can sit there with
 * holders. Zero-supply rows with at least ETH_ZERO_SUPPLY_MIN_HOLDERS holders stay
 * candidates: only 4 placeholder+zero-supply rows hold 2–99, so the carve-out costs
 * almost nothing and keeps exactly the rows #190 exists for.
 *
 * BNB keeps the wider predicate: its deep rows still heal (14 of 40 in the latest run).
 *
 * The placeholder, zero-supply and BEP20 terms are LITERALS in the SQL text, not bound
 * parameters, because they are what tokens_heal_candidates_idx is partial over
 * (ensure-schema.ts's TOKENS_HEAL_PREDICATE). Postgres only uses a partial index when it
 * can prove the WHERE implies the index predicate, and a `$1` cannot prove anything under
 * a generic plan (plan_cache_mode = force_generic_plan, or a named/prepared statement
 * after five executions): the scan then falls back to a sorted walk of
 * tokens_holder_count_idx, with no other index left to catch it. The client's unnamed
 * statements are planned with their values, so prod would have survived on bound
 * parameters; a literal makes that not matter. Every value rendered this way is a code
 * constant (UNKNOWN_NAME, UNKNOWN_SYMBOL, 'BEP20'), never input, and goes through
 * sqlLiteral() regardless. The ETH-only terms stay bound: they only filter.
 */
export function healCandidatePredicate(chain: ChainKey): SQL {
  const nameIsPlaceholder = sql`${tokens.name} in (${sqlLiteral(UNKNOWN_NAME)}, ${sqlLiteral('')})`
  const symbolIsPlaceholder = sql`${tokens.symbol} in (${sqlLiteral(UNKNOWN_SYMBOL)}, ${sqlLiteral('')})`
  if (chain === 'eth') {
    return and(
      or(nameIsPlaceholder, symbolIsPlaceholder),
      or(ne(tokens.totalSupply, '0'), gte(tokens.holderCount, ETH_ZERO_SUPPLY_MIN_HOLDERS)),
    )!
  }
  return or(
    nameIsPlaceholder,
    symbolIsPlaceholder,
    sql`(${tokens.totalSupply} = 0 and ${tokens.type} = ${sqlLiteral('BEP20')})`,
  )!
}

/** A string rendered into the SQL text as a quoted literal. Only for code constants. */
export function sqlLiteral(value: string): SQL {
  return sql.raw(`'${value.replace(/'/g, "''")}'`)
}

/**
 * Candidates strictly after `cursor` in list order, or all of them from the top.
 *
 * A ROW comparison, not `holder_count < h OR (holder_count = h AND address < a)`:
 * Postgres turns a row comparison into an Index Cond on
 * tokens_heal_candidates_idx (holder_count DESC, address DESC, partial over the
 * candidates of both chains), so the scan starts AT the cursor. The OR spelling
 * cannot be an index bound; measured on PG16 it walked tokens_holder_count_idx from
 * the top of the table, discarded every row before the cursor through a heap Filter,
 * and finished with a sort. A row comparison only works when every column runs the
 * same direction, which is why the index and healCandidateOrder are both DESC on
 * address.
 *
 * The index is partial, so Postgres uses it only when it can prove this WHERE implies
 * the index predicate (ensure-schema.ts's TOKENS_HEAL_PREDICATE). It can under custom
 * AND generic plans because the predicate's terms are literals (see
 * healCandidatePredicate); the cursor and limit stay bound, and a row comparison with
 * bound operands is still an Index Cond. Pinned against a real Postgres, both plan
 * modes, by token-heal.pg.test.ts.
 */
export function healCandidateWhere(chain: ChainKey, cursor: HealCursor | null): SQL {
  const predicate = healCandidatePredicate(chain)
  if (cursor === null) return predicate
  return and(predicate, sql`(${tokens.holderCount}, ${tokens.address}) < (${cursor.holderCount}, ${cursor.address})`)!
}

/**
 * The HEAD: candidates with at least HEAD_MIN_HOLDERS holders, listed from the top
 * every run (no cursor), at most HEAD_LIMIT of them. holder_count is recomputed every
 * 15 minutes, so a candidate can climb above the keyset cursor after it has passed;
 * the head is how the healer still sees it next run (see collectHealRun). It is a
 * range on the leading index column, in index order, so it is cheap: measured on
 * production 2026-10-06 (read-only EXPLAIN ANALYZE), BNB has 31,049 tokens with >= 2
 * holders and 19 of them are candidates (head query 23.6 ms); ETH 10,085 and 9 (6.7 ms).
 */
export const HEAD_MIN_HOLDERS = 2
export const HEAD_LIMIT = 500

export function healHeadWhere(chain: ChainKey): SQL {
  return and(healCandidatePredicate(chain), gte(tokens.holderCount, HEAD_MIN_HOLDERS))!
}

/** The order the keyset above and the index agree on. */
export const healCandidateOrder = [desc(tokens.holderCount), desc(tokens.address)] as const
