import { asc, eq } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { swallow } from '@/lib/observability'
import type { StripTx } from '@/lib/tape'

export interface BlockStripData { txs: StripTx[]; gasLimit: number }

/**
 * A locally indexed block's transactions for the block strip, in tx_index order. Null when the
 * block is not indexed, has no transactions, is only partly persisted (fewer rows than its
 * tx_count: a strip must never draw a partial block as complete), or a query fails.
 */
export async function getBlockStrip(blockNumber: number): Promise<BlockStripData | null> {
  try {
    const [[block], rows] = await Promise.all([
      db.select({ txCount: schema.blocks.txCount, gasLimit: schema.blocks.gasLimit })
        .from(schema.blocks).where(eq(schema.blocks.number, blockNumber)).limit(1),
      db.select({
        i: schema.transactions.txIndex,
        gasUsed: schema.transactions.gasUsed,
        gasPrice: schema.transactions.gasPrice,
        status: schema.transactions.status,
      }).from(schema.transactions)
        .where(eq(schema.transactions.blockNumber, blockNumber))
        .orderBy(asc(schema.transactions.txIndex)),
    ])
    if (!block || block.txCount <= 0 || rows.length !== block.txCount) return null
    return {
      gasLimit: Number(block.gasLimit ?? 0),
      txs: rows.map(r => ({ i: r.i, gas: Number(r.gasUsed), price: Number(r.gasPrice), ok: r.status })),
    }
  } catch (e) {
    swallow('block-strip', e)
    return null
  }
}
