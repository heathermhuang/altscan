import { and, asc, desc, eq, ne, type AnyColumn, type SQL } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/pg-core'
import type { Db, schema } from '@altscan/db'

/**
 * Rows of `table` that `address` sent or received, for POST /api/v1/query.
 *
 * NOT `(from_address = a OR to_address = a) ORDER BY block_number LIMIT n`. No
 * index serves that filter and that order together, so for an address the
 * planner thinks is busy it walks the block_number index and filters every row
 * until n match. When the matches sit at the far end of the walk — the first 10
 * transfers of an address that is only busy now — that is the whole table. On
 * BNB it hit the 15s statement_timeout ~95 times an hour, each time after
 * streaming the few early matches, which is what left holes in the next result
 * on the same connection (patches/postgres@3.4.8.patch).
 *
 * Instead, one arm per side, each an early-stopping walk of its
 * `(address, timestamp DESC)` index, and the page is cut from their union. An
 * arm needs `offset + limit` rows at most: the page cannot hold more than that
 * from either side. The `to` arm drops rows the `from` arm already has (a
 * self-transfer), so the union holds each of the OR's rows exactly once. It
 * drops them after its LIMIT, not in its WHERE: a bot that mostly sends to
 * itself (0x9999…0515 on BNB) left that walk filtering its whole history, past
 * the statement timeout. Dropping them after the cut loses nothing, because a
 * self-transfer that belongs on the page is within the `from` arm's first
 * `offset + limit` rows too.
 *
 * `(timestamp, block_number)` is the sort key, not `block_number` alone: the
 * index is ordered by timestamp, and a block's timestamp never runs backwards,
 * so this is still block order, with consecutive blocks that share a second
 * ordered by block. The arms and the outer ORDER BY must stay identical, or
 * cutting each arm at `offset + limit` stops being exact. `tieBreak` appends a
 * last key to both, for a caller that pages through several rows of one block
 * (the address page orders a block's transactions by tx_index).
 */
export function selectByAddress(
  db: Db,
  table: typeof schema.transactions | typeof schema.tokenTransfers,
  address: string,
  conditions: SQL[],
  page: { order: string; limit: number; offset: number; tieBreak?: AnyColumn },
) {
  const dir = page.order === 'asc' ? asc : desc
  // Built fresh per use: drizzle rewrites a set operation's ORDER BY in place.
  const sortKey = () => [
    dir(table.timestamp), dir(table.blockNumber), ...(page.tieBreak ? [dir(page.tieBreak)] : []),
  ]
  const arm = (side: SQL) => db.select().from(table)
    .where(and(side, ...conditions))
    .orderBy(...sortKey())
    .limit(page.offset + page.limit)
  const toSide = arm(eq(table.toAddress, address)).as('to_side')
  return unionAll(
    arm(eq(table.fromAddress, address)),
    // Both arms read the same `table`, so their shapes match by construction.
    // drizzle >= 0.44 checks the right arm's shape against the left's, and with
    // `table` typed as a union it compares every pairing, including a
    // transactions arm against a token_transfers arm, which cannot occur. The
    // result type still comes from the left arm.
    db.select().from(toSide).where(ne(toSide.fromAddress, address)) as never,
  )
    .orderBy(...sortKey())
    .limit(page.limit)
    .offset(page.offset)
}

/**
 * Rows of `table` matching `conditions`, which hold POST /api/v1/query's
 * `filter.from`, `filter.to` or `filter.tokenAddress` (an equality on
 * from_address, to_address or token_address).
 *
 * Ordered by `(timestamp, block_number)`, not `block_number`, for the reason
 * selectByAddress is: with `ORDER BY block_number` the planner walks the
 * block_number index and filters every row until n match, which for an address
 * or token whose rows sit at the far end of that walk is most of the table. On
 * BNB a `filter.to` of an ordinary address, and a `filter.tokenAddress` of a
 * quiet token, timed out at 15s in one or both orders. Each of those columns
 * leads a `(column, timestamp DESC)` index, so in this order the walk stops after
 * `offset + limit` of its own rows. It is still block order.
 */
export function selectInTimeOrder(
  db: Db,
  table: typeof schema.transactions | typeof schema.tokenTransfers,
  conditions: SQL[],
  page: { order: string; limit: number; offset: number },
) {
  const dir = page.order === 'asc' ? asc : desc
  return db.select().from(table)
    .where(and(...conditions))
    .orderBy(dir(table.timestamp), dir(table.blockNumber))
    .limit(page.limit)
    .offset(page.offset)
}
