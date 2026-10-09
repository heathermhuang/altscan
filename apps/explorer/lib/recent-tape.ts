import { desc } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { chainConfig } from '@/lib/chain'
import { swallow } from '@/lib/observability'
import { encodeTape, latestTapeCount, spreadSeconds, toTapeTuple } from '@/lib/tape'

// Same bound as the charts queries it was written beside (app/charts/page.tsx keeps its own copy:
// that helper is shared with its other, unrelated queries).
const DB_TIMEOUT_MS = 8000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('query timeout')), DB_TIMEOUT_MS)
    ),
  ])
}

// The newest blocks as a tape (same window as the homepage, one primary-key-ordered query), for
// when there are no daily charts to draw. null if there is nothing to show.
export async function fetchRecentTape(): Promise<string | null> {
  try {
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
      .limit(latestTapeCount(chainConfig.blockTime)))
    const tuples = rows.map(toTapeTuple)
    return spreadSeconds(tuples).length > 0 ? encodeTape(tuples) : null
  } catch (e) {
    swallow('recent-tape', e)
    return null
  }
}
