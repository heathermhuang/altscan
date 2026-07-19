/**
 * Track A4b — enqueue an entity for lazy provider backfill.
 *
 * Under the R1 serve model the live provider always serves page 1, so this
 * trigger is not about making an unservable view servable. Its job is to WARM
 * THE CACHE FOR PAGINATION: enqueue on the first human view so that by the time
 * the user pages past the head, the deep tail is already local (zero provider
 * CU, and resilient if the provider is down later).
 */
import { getDb, schema } from '@altscan/db'
import { chainConfig } from './chain'

/** Pure decision — the part worth testing. */
export function shouldEnqueueBackfill(o: {
  backfillEnabled: boolean
  isBot: boolean
  watermarkExists: boolean
}): boolean {
  return o.backfillEnabled && !o.isBot && !o.watermarkExists
}

/**
 * Whether backfill is on for THIS deployment.
 *
 * Two independent gates, both of which must allow it: the per-chain config
 * flag, and a `BACKFILL_ENABLED=0` env kill switch so a chain can be turned off
 * without a code deploy. Read as `=== true` so an absent `backfill` object is
 * as safe as an explicit false.
 */
export function backfillEnabled(): boolean {
  if (process.env.BACKFILL_ENABLED === '0') return false
  return chainConfig.provider?.backfill?.enabled === true
}

/**
 * Fire-and-forget enqueue. At most one watermark per entity — the unique
 * constraint plus ON CONFLICT DO NOTHING makes the check-then-insert race
 * harmless, so callers never need to serialize.
 *
 * NEVER blocks or fails the request: a backfill that does not get queued costs
 * a cache warm, while a request that 500s because the queue insert failed costs
 * the user their page.
 */
export async function enqueueBackfill(
  entityType: 'address_txs' | 'token_transfers',
  entityId: string,
): Promise<void> {
  try {
    await getDb()
      .insert(schema.backfillWatermarks)
      .values({ entityType, entityId: entityId.toLowerCase(), status: 'pending' })
      .onConflictDoNothing()
  } catch {
    /* best-effort by design — see doc comment */
  }
}
