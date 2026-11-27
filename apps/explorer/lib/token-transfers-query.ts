import { count, desc, eq, sql } from 'drizzle-orm'
import { schema, type Db } from '@altscan/db'
import { MAX_LIST_ROWS } from './list-depth'

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

/**
 * A token's transfer count, counted no further than one row past the list.
 *
 * COUNT(*) visits every matching row whichever index it uses, so it is as slow
 * as the token is busy: on BNB it hit the statement_timeout 11 times in the
 * same window. Past MAX_LIST_ROWS the page only needs to know there
 * are more.
 *
 * The ORDER BY is what makes the LIMIT a bound: it walks the list's index.
 * Without it the planner may read the heap in physical order until enough rows
 * match, and a busy token's rows can sit anywhere in it — on the test's plain
 * (ETH-shaped) table that read 110,001 rows to count 10,001.
 */
export function countTokenTransfers(db: Db, token: string) {
  const served = db
    .select({ one: sql<number>`1`.as('one') })
    .from(schema.tokenTransfers)
    .where(eq(schema.tokenTransfers.tokenAddress, token))
    .orderBy(desc(schema.tokenTransfers.timestamp))
    .limit(MAX_LIST_ROWS + 1)
    .as('served')
  return db.select({ value: count() }).from(served)
}
