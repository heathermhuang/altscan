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
import { isBackfillEnabled } from '@altscan/chain-config'
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
 * Whether backfill is on for THIS deployment — the per-chain config flag with a
 * `BACKFILL_ENABLED` env override (see isBackfillEnabled in @altscan/chain-config).
 * The indexer worker gate reads the SAME helper, so both sides of A4b flip
 * together on a single env change per service — no code deploy, symmetric rollback.
 */
export function backfillEnabled(): boolean {
  return isBackfillEnabled(chainConfig)
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
    // MUST pass the chain's dbEnvVar: bare getDb() defaults to DATABASE_URL, which
    // is UNSET on eth-web (it uses ETH_DATABASE_URL) — so in production it threw,
    // the best-effort catch below swallowed it, and NOTHING was ever enqueued on
    // ETH. Symptom: worker ON but permanently idle. Do not "simplify" this back.
    await getDb(chainConfig.dbEnvVar)
      .insert(schema.backfillWatermarks)
      .values({ entityType, entityId: entityId.toLowerCase(), status: 'pending' })
      .onConflictDoNothing()
  } catch (err) {
    /* best-effort by design — see doc comment. Still NEVER rethrow: the request
     * must survive. But do not swallow SILENTLY: this catch is why a wrong DB
     * env var went unnoticed for weeks (A4b was inert on ETH while the worker
     * logged "ON"). A misconfig, a missing table, and a healthy-but-empty queue
     * were indistinguishable from the outside. Throttled so a sustained outage
     * cannot flood the log. */
    warnEnqueueFailure(err)
  }
}

/** Log at most one enqueue failure per THROTTLE_MS, with a drop count. */
const THROTTLE_MS = 60_000
let lastWarnAt = 0
let suppressed = 0
function warnEnqueueFailure(err: unknown): void {
  const now = Date.now()
  if (now - lastWarnAt < THROTTLE_MS) { suppressed++; return }
  const also = suppressed > 0 ? ` (+${suppressed} suppressed in the last ${THROTTLE_MS / 1000}s)` : ''
  lastWarnAt = now
  suppressed = 0
  console.warn(
    `[backfill] enqueue FAILED for chain=${chainConfig.key} db=${chainConfig.dbEnvVar}${also}: ` +
    (err instanceof Error ? err.message : String(err)),
  )
}
