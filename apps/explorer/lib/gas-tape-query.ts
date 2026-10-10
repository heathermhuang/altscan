import { desc } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { rowFromBlock, type GasTapeRow } from '@/lib/gas-tape'
import { TAPE_LATEST } from '@/lib/tape'
import { withTimeout } from '@/lib/with-timeout'

/**
 * The newest blocks for the /gas tape: one primary-key-ordered read of TAPE_LATEST rows. THROWS on a
 * failed or timed-out query, so a page cache around it (lib/page-cache.ts) never stores a failure.
 */
export async function queryGasTape(): Promise<GasTapeRow[]> {
  const rows = await withTimeout(db
    .select({
      number: schema.blocks.number,
      txCount: schema.blocks.txCount,
      gasUsed: schema.blocks.gasUsed,
      gasLimit: schema.blocks.gasLimit,
      baseFeePerGas: schema.blocks.baseFeePerGas,
    })
    .from(schema.blocks)
    .orderBy(desc(schema.blocks.number))
    .limit(TAPE_LATEST))
  return rows.map(rowFromBlock)
}
