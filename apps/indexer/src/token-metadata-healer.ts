/**
 * Re-fetches token metadata that the one-shot first-sight fetch (block-processor's
 * ensureTokensBatch) left as a placeholder — 'Unknown' / '???' / total_supply 0 —
 * because an eth_call was rate-limited or the token returns bytes32.
 *
 * Runs in the indexer process on BOTH chains. It must stay invisible to indexing:
 * it never throws out of its timer, shares nothing with processBlock, uses the
 * small maintenance pool, and calls the RPC strictly one request at a time (the
 * batch is what gets rate-limited). Everything it decides lives in token-metadata.ts.
 */
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import type { JsonRpcProvider } from 'ethers'
import { getMaintenanceDb, schema, dbErrorMessage } from './db'
import { indexerConfig } from './config-instance'
import { withTimeout } from './rpc-failover'
import {
  HEAL_RETRY_MS, UNKNOWN_NAME, UNKNOWN_SYMBOL,
  fetchTokenMetadata, planHeal, pruneTried, selectHealBatch,
  type HealRow,
} from './token-metadata'

const TAG = '[token-heal]'
const INITIAL_DELAY_MS = 2 * 60 * 1000
/** No new token is started once a run has been going this long. */
const RUN_BUDGET_MS = 60 * 1000
/** One token's four calls. A throttled endpoint hangs rather than errors. */
const TOKEN_TIMEOUT_MS = 15 * 1000
const DELAY_BETWEEN_TOKENS_MS = 250
/**
 * Most already-tried addresses the candidate query over-fetches to skip past.
 * Bounds the page (and the index walk behind it): a token that can never resolve
 * (no name() at all) is retried daily, so the top of the holder ranking cannot be
 * crowded out for good, but beyond this depth the junk tail is deliberately not reached.
 */
const MAX_SKIPPED = 2_000

// Address -> when it was last tried. In memory on purpose: a deploy retries the
// top of the list once, which is harmless, and no schema change is needed.
const tried = new Map<string, number>()
let running = false
let providerCursor = 0

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function runOnce(providers: readonly JsonRpcProvider[], batchSize: number): Promise<void> {
  if (running) return
  running = true
  const started = Date.now()
  try {
    pruneTried(tried, started)
    const db = getMaintenanceDb()
    // Candidates come back in holder order; the already-tried ones are skipped in
    // JS (a NOT IN list that long would also overflow drizzle's recursive sql.join).
    const page: HealRow[] = await db
      .select({
        address: schema.tokens.address,
        name: schema.tokens.name,
        symbol: schema.tokens.symbol,
        decimals: schema.tokens.decimals,
        totalSupply: schema.tokens.totalSupply,
        type: schema.tokens.type,
        holderCount: schema.tokens.holderCount,
      })
      .from(schema.tokens)
      .where(or(
        inArray(schema.tokens.name, [UNKNOWN_NAME, '']),
        inArray(schema.tokens.symbol, [UNKNOWN_SYMBOL, '']),
        and(eq(schema.tokens.totalSupply, '0'), eq(schema.tokens.type, 'BEP20')),
      ))
      .orderBy(desc(schema.tokens.holderCount))
      .limit(batchSize + Math.min(tried.size, MAX_SKIPPED))
    const batch = selectHealBatch(page, tried, started, batchSize, HEAL_RETRY_MS)

    let attempted = 0
    let healed = 0
    let topUnresolvedHolders = 0
    for (const row of batch) {
      if (Date.now() - started > RUN_BUDGET_MS) break
      attempted++
      tried.set(row.address, Date.now())
      const provider = providers[providerCursor++ % providers.length]
      const patch = await withTimeout(
        fetchTokenMetadata(provider, row.address, { sequential: true }),
        TOKEN_TIMEOUT_MS,
        'token-heal fetch',
      ).then(meta => planHeal(row, meta), () => null)
      if (patch) {
        await db.update(schema.tokens).set(patch).where(eq(schema.tokens.address, row.address))
        healed++
      } else {
        topUnresolvedHolders = Math.max(topUnresolvedHolders, row.holderCount)
      }
      await sleep(DELAY_BETWEEN_TOKENS_MS)
    }
    console.log(`${TAG} tried ${attempted}, healed ${healed}, still-unresolved ${attempted - healed} (top holder ${topUnresolvedHolders})`)
  } catch (err) {
    console.error(`${TAG} error:`, dbErrorMessage(err))
  } finally {
    running = false
  }
}

/** Called once from index.ts's boot; `providers` is the same pool block fetches use. */
export function startTokenMetadataHealer(providers: readonly JsonRpcProvider[]): void {
  const cfg = indexerConfig.tokenHeal
  if (!cfg.enabled) {
    console.log(`${TAG} disabled (TOKEN_HEAL_ENABLED=0)`)
    return
  }
  if (providers.length === 0) return
  console.log(`${TAG} every ${cfg.intervalMin}min, up to ${cfg.batch} tokens per run`)
  // runOnce catches everything; the .catch only guards against a future edit.
  const tick = () => { runOnce(providers, cfg.batch).catch(err => console.error(`${TAG} error:`, dbErrorMessage(err))) }
  setTimeout(() => {
    tick()
    setInterval(tick, cfg.intervalMin * 60 * 1000)
  }, INITIAL_DELAY_MS)
}
