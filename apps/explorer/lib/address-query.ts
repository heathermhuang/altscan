import { and, asc, desc, eq, ne, type SQL } from 'drizzle-orm'
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
 * from either side. The `to` arm skips rows the `from` arm already has (a
 * self-transfer), so the union holds each of the OR's rows exactly once.
 *
 * `(timestamp, block_number)` is the sort key, not `block_number` alone: the
 * index is ordered by timestamp, and a block's timestamp never runs backwards,
 * so this is still block order, with consecutive blocks that share a second
 * ordered by block. The arms and the outer ORDER BY must stay identical, or
 * cutting each arm at `offset + limit` stops being exact.
 */
export function selectByAddress(
  db: Db,
  table: typeof schema.transactions | typeof schema.tokenTransfers,
  address: string,
  conditions: SQL[],
  page: { order: string; limit: number; offset: number },
) {
  const dir = page.order === 'asc' ? asc : desc
  const arm = (side: SQL | undefined) => db.select().from(table)
    .where(and(side, ...conditions))
    .orderBy(dir(table.timestamp), dir(table.blockNumber))
    .limit(page.offset + page.limit)
  return unionAll(
    arm(eq(table.fromAddress, address)),
    // Both arms read the same `table`, so their shapes match by construction.
    // drizzle >= 0.44 checks the right arm's shape against the left's, and with
    // `table` typed as a union it compares every pairing, including a
    // transactions arm against a token_transfers arm, which cannot occur. The
    // result type still comes from the left arm.
    arm(and(eq(table.toAddress, address), ne(table.fromAddress, address))) as never,
  )
    .orderBy(dir(table.timestamp), dir(table.blockNumber))
    .limit(page.limit)
    .offset(page.offset)
}
