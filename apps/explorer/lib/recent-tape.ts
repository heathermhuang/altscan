import { desc } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { swallow } from '@/lib/observability'
import { encodeTape, TAPE_LATEST, toTapeTuple } from '@/lib/tape'
import { withTimeout } from '@/lib/with-timeout'

// The newest blocks as a tape, shared by /charts (its fallback when there are no daily charts to
// draw) and /blocks. Same block count as the homepage, one primary-key-ordered query.

/** The tape, or null if there is nothing to draw. THROWS on a failed or timed-out query, so a cache
 *  wrapped around it (lib/page-cache.ts) never stores a failure. */
export async function queryRecentTape(): Promise<string | null> {
  const rows = await withTimeout(db
    .select({
      number: schema.blocks.number,
      timestamp: schema.blocks.timestamp,
      gasUsed: schema.blocks.gasUsed,
      gasLimit: schema.blocks.gasLimit,
      txCount: schema.blocks.txCount,
    })
    .from(schema.blocks)
    .orderBy(desc(schema.blocks.number))
    .limit(TAPE_LATEST))
  const tuples = rows.map(toTapeTuple)
  return tuples.length > 0 ? encodeTape(tuples) : null
}

/** `queryRecentTape` for a caller with no cache of its own: a failure is logged and reads as "no tape". */
export async function fetchRecentTape(): Promise<string | null> {
  try {
    return await queryRecentTape()
  } catch (e) {
    swallow('recent-tape', e)
    return null
  }
}
