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
import { eq } from 'drizzle-orm'
import type { JsonRpcProvider } from 'ethers'
import { getChainConfig } from '@altscan/chain-config'
import { getMaintenanceDb, schema, dbErrorMessage } from './db'
import { indexerConfig } from './config-instance'
import { withTimeout } from './rpc-failover'
import { HEAD_LIMIT, healCandidateOrder, healCandidateWhere, healHeadWhere } from './token-heal-query'
import {
  collectHealRun, decideHeal, describeHealCursor, fetchTokenMetadata, pruneTried, resumeHealCursor,
  type HealCursor,
} from './token-metadata'

const TAG = '[token-heal]'
const INITIAL_DELAY_MS = 2 * 60 * 1000
/** No new token is started once a run has been going this long. */
const RUN_BUDGET_MS = 60 * 1000
/** One token's four calls. A throttled endpoint hangs rather than errors. */
const TOKEN_TIMEOUT_MS = 15 * 1000
const DELAY_BETWEEN_TOKENS_MS = 250
const chainKey = getChainConfig().key

// Address -> when it was last tried. In memory on purpose: a deploy retries the
// top of the list once, which is harmless, and no schema change is needed.
const tried = new Map<string, number>()
// Where the last run stopped in the candidate list (null = the top). In memory for
// the same reason as `tried`: a deploy restarts the walk from the top. Without it
// every run began at the top and skipped what it had already tried, so once the
// untouchable rows at the head (tokens that never answer) had all been tried, the
// healer ran dry until their 24h window lapsed — and then began at the same rows again.
let healCursor: HealCursor | null = null
// Address -> runs it has failed for a transport reason (see decideHeal). Cleared
// wholesale past this size rather than aged: entries are one number per address.
const strikes = new Map<string, number>()
const MAX_STRIKE_ENTRIES = 5_000
let running = false
let providerCursor = 0

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function runOnce(providers: readonly JsonRpcProvider[], batchSize: number): Promise<void> {
  if (running) return
  running = true
  const started = Date.now()
  try {
    pruneTried(tried, started)
    if (strikes.size > MAX_STRIKE_ENTRIES) strikes.clear()
    const db = getMaintenanceDb()
    // The head (high-holder candidates, re-listed from the top every run) comes first,
    // then keyset paging in holder order fills the rest: each page resumes at the
    // cursor, so the walk reaches the whole list. Rows tried within 24h are skipped in
    // JS (a NOT IN list that long would also overflow drizzle's recursive sql.join).
    const pageSize = batchSize * 2
    const healColumns = {
      address: schema.tokens.address,
      name: schema.tokens.name,
      symbol: schema.tokens.symbol,
      decimals: schema.tokens.decimals,
      totalSupply: schema.tokens.totalSupply,
      type: schema.tokens.type,
      holderCount: schema.tokens.holderCount,
    }
    const run = await collectHealRun(
      async () => db
        .select(healColumns)
        .from(schema.tokens)
        .where(healHeadWhere(chainKey))
        .orderBy(...healCandidateOrder)
        .limit(HEAD_LIMIT),
      async (after, limit) => db
        .select(healColumns)
        .from(schema.tokens)
        .where(healCandidateWhere(chainKey, after))
        .orderBy(...healCandidateOrder)
        .limit(limit),
      healCursor, tried, started, { batchSize, pageSize },
    )
    const scan = run.scan
    const batch = [...run.head, ...scan.taken.map(t => t.row)]

    let attempted = 0
    let healed = 0
    let transportErrors = 0
    let streak = 0
    let stoppedEarly = false
    let topUnresolvedHolders = 0
    for (const row of batch) {
      if (Date.now() - started > RUN_BUDGET_MS) break
      attempted++
      const provider = providers[providerCursor++ % providers.length]
      const meta = await withTimeout(
        fetchTokenMetadata(provider, row.address, { sequential: true }),
        TOKEN_TIMEOUT_MS,
        'token-heal fetch',
      ).catch(() => null) // a hung endpoint: no answer, so a transport failure
      const step = decideHeal(row, meta, streak, strikes.get(row.address) ?? 0)
      streak = step.streak
      if (step.strikes > 0) strikes.set(row.address, step.strikes)
      else strikes.delete(row.address)
      if (step.transportFailed) transportErrors++
      if (step.patch) {
        await db.update(schema.tokens).set(step.patch).where(eq(schema.tokens.address, row.address))
        healed++
      } else {
        topUnresolvedHolders = Math.max(topUnresolvedHolders, row.holderCount)
      }
      // After the write, so a DB error aborting the run leaves the token to the next tick.
      if (step.markTried) tried.set(row.address, Date.now())
      if (step.stop) { stoppedEarly = true; break }
      await sleep(DELAY_BETWEEN_TOKENS_MS)
    }
    // Only now, so an error that aborts the run (a DB error above) leaves the cursor where it was.
    // The tail scan only: head rows that were not settled come back through the head.
    const resume = resumeHealCursor(scan, row => tried.has(row.address))
    healCursor = resume.cursor
    if (stoppedEarly) console.warn(`${TAG} stopped early: ${transportErrors} transport errors`)
    console.log(`${TAG} tried ${attempted}, healed ${healed}, still-unresolved ${attempted - healed} (top holder ${topUnresolvedHolders}), transport errors ${transportErrors}, head ${Math.min(attempted, run.head.length)}, cursor ${describeHealCursor(resume)}`)
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
