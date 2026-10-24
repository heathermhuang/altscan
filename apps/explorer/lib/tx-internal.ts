import { and, eq, sql } from 'drizzle-orm'
import { schema, type Db } from '@altscan/db'

/**
 * How many internal transactions a tx page lists. The page reads one row more than this, only to
 * learn whether the transaction has more than the list shows (mirrors TX_TRANSFERS_SHOWN).
 */
export const TX_INTERNALS_SHOWN = 100

/**
 * One transaction's value-moving internal calls, in execution order, for /tx/[hash].
 *
 * Filtered by block_number as well as tx_hash: internal_transactions is RANGE-partitioned by block
 * number, so the block bounds the read to one partition, and a hash that was reorged into another
 * height cannot list the same call twice. Ordered in SQL, BEFORE the limit: with no ORDER BY the
 * LIMIT kept an arbitrary subset of a busy transaction's calls and the heading counted that sample.
 * The order is by the trace address read as integers ('0.10' follows '0.2', and a parent call
 * precedes its children), which is how a string sort gets it wrong.
 */
export function selectTxInternals(db: Db, txHash: string, blockNumber: number) {
  const t = schema.internalTransactions
  return db
    .select()
    .from(t)
    .where(and(eq(t.txHash, txHash), eq(t.blockNumber, blockNumber)))
    .orderBy(sql`string_to_array(${t.traceAddress}, '.')::int[]`)
    .limit(TX_INTERNALS_SHOWN + 1)
}

export function capTxInternals<T>(rows: readonly T[]): { shown: T[]; truncated: boolean } {
  return { shown: rows.slice(0, TX_INTERNALS_SHOWN), truncated: rows.length > TX_INTERNALS_SHOWN }
}
