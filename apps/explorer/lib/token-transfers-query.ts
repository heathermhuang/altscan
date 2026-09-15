import { desc, eq } from 'drizzle-orm'
import { schema, type Db } from '@altscan/db'

/**
 * How deep the token page's transfer list goes: 400 pages of 25.
 *
 * A page reads every row before it, so without a cap `?page=` sets the cost of
 * the query. In 6h40m of logs on 2026-09-13 crawlers walked to page 198;
 * nothing asked for page 400.
 */
export const TOKEN_TRANSFERS_MAX_ROWS = 10_000

/**
 * A page of a token's transfers, newest first, for /token/[address].
 *
 * NOT `ORDER BY block_number DESC`. No index serves `token_address = $1` and
 * that order together, so the planner walks the block_number index from the
 * tip and filters every row until the page fills. For a token that has gone
 * quiet that is every transfer since its last one. On BNB it hit the 15s
 * statement_timeout 34 times in those 6h40m and took 2-15s another 154 times;
 * past 6s the page gave up and rendered "No transfers yet."
 *
 * `(timestamp, block_number)` is the order `(token_address, timestamp DESC)`
 * serves, and a block's timestamp never runs backwards, so it is still block
 * order, with consecutive blocks that share a second ordered by block. The walk
 * reads `offset + limit` rows of this token and stops.
 */
export function selectTokenTransfers(db: Db, token: string, page: { limit: number; offset: number }) {
  return db
    .select()
    .from(schema.tokenTransfers)
    .where(eq(schema.tokenTransfers.tokenAddress, token))
    .orderBy(desc(schema.tokenTransfers.timestamp), desc(schema.tokenTransfers.blockNumber))
    .limit(page.limit)
    .offset(page.offset)
}
