import { eq } from 'drizzle-orm'
import { db, schema } from './db'
import { swallowed } from './observability'
import { getRetentionFloor, isLocalHistoryIncomplete } from './retention'

/**
 * Whether retention has cut this address's lists short. The index keeps only a
 * few days, so empty lists alone cannot tell "no activity" from "nothing
 * recent". addresses.first_seen is never pruned, so a first_seen older than the
 * retention floor means the index has dropped this address's earliest
 * transactions: the check the address page makes (lib/retention.ts). null when either
 * side is unknown, including an address the index has no row for: whatever
 * history it has, the index cannot vouch for it.
 *
 * Shared by the address JSON route and the CSV export, so both say the same thing about
 * the same rows. Never rejects.
 */
export async function readCoverage(address: string) {
  const [firstSeen, indexedFrom] = await Promise.all([
    db
      .select({ firstSeen: schema.addresses.firstSeen })
      .from(schema.addresses)
      .where(eq(schema.addresses.address, address))
      .limit(1)
      .then((r) => r[0]?.firstSeen ?? null)
      .catch(swallowed('api/v1/addresses/coverage', null)),
    getRetentionFloor(),
  ])
  const historyComplete = firstSeen && indexedFrom ? !isLocalHistoryIncomplete(firstSeen, indexedFrom) : null
  return { historyComplete, indexedFrom }
}
