/**
 * The SQL the token-metadata healer pages through, as pure builders so a test can
 * render and pin it for each chain. The healer owns the I/O; the decisions about
 * WHICH row comes next live in token-metadata.ts.
 */
import { and, desc, eq, gte, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
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
 */
export function healCandidatePredicate(chain: ChainKey): SQL {
  const nameIsPlaceholder = inArray(tokens.name, [UNKNOWN_NAME, ''])
  const symbolIsPlaceholder = inArray(tokens.symbol, [UNKNOWN_SYMBOL, ''])
  if (chain === 'eth') {
    return and(
      or(nameIsPlaceholder, symbolIsPlaceholder),
      or(ne(tokens.totalSupply, '0'), gte(tokens.holderCount, ETH_ZERO_SUPPLY_MIN_HOLDERS)),
    )!
  }
  return or(nameIsPlaceholder, symbolIsPlaceholder, and(eq(tokens.totalSupply, '0'), eq(tokens.type, 'BEP20')))!
}

/**
 * Candidates strictly after `cursor` in list order, or all of them from the top.
 *
 * A ROW comparison, not `holder_count < h OR (holder_count = h AND address < a)`:
 * Postgres turns a row comparison into an Index Cond on
 * tokens_holder_count_address_idx (holder_count DESC, address DESC), so the scan
 * starts AT the cursor. The OR spelling cannot be an index bound; measured on PG16
 * it walked tokens_holder_count_idx from the top of the table, discarded every row
 * before the cursor through a heap Filter, and finished with a sort. A row
 * comparison only works when every column runs the same direction, which is why
 * the index and healCandidateOrder are both DESC on address.
 */
export function healCandidateWhere(chain: ChainKey, cursor: HealCursor | null): SQL {
  const predicate = healCandidatePredicate(chain)
  if (cursor === null) return predicate
  return and(predicate, sql`(${tokens.holderCount}, ${tokens.address}) < (${cursor.holderCount}, ${cursor.address})`)!
}

/** The order the keyset above and the index agree on. */
export const healCandidateOrder = [desc(tokens.holderCount), desc(tokens.address)] as const
