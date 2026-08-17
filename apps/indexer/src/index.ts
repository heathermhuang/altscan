/**
 * Chain-configurable block indexer — serves both BNB Chain and Ethereum.
 *
 * Set CHAIN=bnb or CHAIN=eth to select the target chain.
 *
 * Env vars:
 *   CHAIN              — Chain to index: "bnb" (default) or "eth"
 *   BNB_RPC_URL / ETH_RPC_URL — JSON-RPC endpoint (chain-specific)
 *   DATABASE_URL / ETH_DATABASE_URL — PostgreSQL connection string (chain-specific)
 *   START_BLOCK        — Block to start from if DB is empty
 *   FORCE_START_BLOCK  — Override DB resume and start from this block regardless
 *   LOG_EVERY          — Log progress every N blocks (default: 50)
 */
import 'dotenv/config'
import { JsonRpcProvider, Network } from 'ethers'
import { getChainConfig } from '@altscan/chain-config'
import {
  processBlock,
  initTransferWriter,
  setDurableFloor,
  enqueueQuarantinedBlock,
  getTransferQueueDepth,
  flushTransferWriter,
  rollbackTransferWriterTo,
  ASYNC_TT_WRITER,
  TT_QUEUE_HIGH_WATER_ROWS,
  TT_QUEUE_HIGH_WATER_BLOCKS,
} from './block-processor'
import { processWithFailover, readWithFailover, redactRpcUrl, withTimeout, failoverKind } from './rpc-failover'
import { createEndpointHealth } from './endpoint-health'
import { recordIndexGap, recordPoisonGapIfAbsent, isPoisonBlock } from './index-gaps'
import {
  PoisonBlockTracker, shouldQuarantine, DEFAULT_QUARANTINE_AFTER, poisonGapReason,
} from './poison-block'
import { healNextGap, positiveIntEnv, DEFAULT_HEAL_BATCH, DEFAULT_HEAL_MAX_LAG } from './gap-healer'
import { RPC_URLS as SHARED_RPC_URLS, safeRpcError } from './provider'
import { detectReorgPinned, makeReorgDepsFrom, resolveReorgDepth, unwindFrom } from './reorg-handler'
import { syncValidators } from './validator-syncer'
import { startRetentionCleanup, reportIndexerLag } from './retention-cleanup'
import { startBackfillWorker } from './backfill-worker'
import { ensureSchema } from './ensure-schema'
import { getDb, schema } from './db'
import { desc, sql } from 'drizzle-orm'

const chain = getChainConfig()
const TAG = `[${chain.brandName}-indexer]`

// BNB_RPC_URL / ETH_RPC_URL may be a single URL or a comma-separated list.
// When multiple URLs are given, block fetches are round-robined across them,
// which distributes per-IP rate-limit pressure across several public endpoints.
// This is the real fix for "indexer falls behind because one public RPC throttles us".
// Parsed once in provider.ts and imported here, so every module that logs an
// RPC-derived error redacts against the exact same endpoint list.
const RPC_URLS = SHARED_RPC_URLS
const POLL_MS     = chain.pollMs
const BATCH_SIZE  = parseInt(process.env.INDEX_BATCH_SIZE ?? '40', 10)
// BNB produces a block every 3s — needs higher concurrency to keep up.
// ETH at 12s can run lower. Default = 8 for BNB, 4 for ETH.
const DEFAULT_CONCURRENCY = chain.key === 'bnb' ? 8 : 4
const CONCURRENCY = parseInt(process.env.INDEX_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10)
const LOG_EVERY   = parseInt(process.env.LOG_EVERY ?? '50', 10)
const RESUME_GAP_SCAN_BLOCKS = parseInt(process.env.RESUME_GAP_SCAN_BLOCKS ?? '20000', 10)

/**
 * EVERY error that could have come from an RPC call goes through here before it
 * reaches a log. ethers embeds the full endpoint — userinfo, path and query — in
 * both the message text and the `info` property of HTTP failures, so passing the
 * raw Error to console.error publishes the key. Defined at module scope so the
 * global handlers below can use it too. (codex P1 rounds 2 and 3.)
 */
const safeErr = safeRpcError

let running = true
process.on('SIGINT',  () => { running = false })
process.on('SIGTERM', () => { running = false })
process.on('unhandledRejection', (err) => {
  console.error(`${TAG} Unhandled rejection:`, safeErr(err))
})
process.on('uncaughtException', (err) => {
  console.error(`${TAG} Uncaught exception:`, safeErr(err))
  process.exit(1)
})

async function main() {
  console.log(`${TAG} Starting ${chain.name} indexer...`)
  // Shared with the failover logger so both paths mask identically — and so a
  // key carried in the path or query (not just basic-auth userinfo) is caught.
  const redactedRpcs = RPC_URLS.map(redactRpcUrl)
  console.log(`${TAG} Chain: ${chain.name} (${chain.key}), RPCs (${RPC_URLS.length}): ${redactedRpcs.join(', ')}`)

  // Retry ensureSchema on DB connection errors (e.g. max_connections exceeded).
  // Retrying instead of crashing prevents Render restart loops from piling up
  // connections and making the situation worse.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureSchema()
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isConnErr = msg.includes('53300') || msg.includes('connection') || msg.includes('ECONNREFUSED')
      if (isConnErr && attempt <= 20) {
        const wait = Math.min(30000, 5000 * attempt)
        console.warn(`${TAG} DB not ready (attempt ${attempt}/20), retrying in ${wait / 1000}s: ${msg}`)
        await sleep(wait)
      } else {
        throw err
      }
    }
  }

  startRetentionCleanup().catch(err => console.error(`${TAG} retention startup error:`, safeErr(err)))

  // Track A4b lazy backfill — gated on chain-config `provider.backfill.enabled`
  // (false on both chains until A4b-2 rollout) + the BACKFILL_ENABLED=0 kill switch.
  startBackfillWorker().catch(err => console.error('[backfill] fatal:', safeErr(err)))

  // One provider per RPC URL. We round-robin `processBlock` across this pool
  // so 8 concurrent block fetches get distributed across N endpoints instead
  // of all landing on one public RPC's rate-limit bucket.
  //
  // `staticNetwork` is CRITICAL: without it, ethers v6 runs an eth_chainId
  // probe before every request and re-enters "detect network" retry loops on
  // any hiccup. Observed 55 "failed to detect network" errors/minute on the
  // 2-RPC BNB setup, which collapsed throughput to 0.89 blk/s. Pinning the
  // network ID up-front eliminates the probe entirely.
  const network = Network.from(chain.chainId)
  const providers = RPC_URLS.map(url =>
    new JsonRpcProvider(url, network, { staticNetwork: network })
  )
  // Endpoint identity for failover logging. Zipped by index — `providers` is
  // built 1:1 from RPC_URLS directly above, so the indices cannot drift.
  const urlLabelOf = new Map(providers.map((p, i) => [p, redactRpcUrl(RPC_URLS[i])]))
  // Throttled: a permanently-sick endpoint fails on a large share of blocks, and
  // one log line each would bury the progress output. First hit reports
  // immediately (so a new failure is never silent), then at most once a minute
  // per endpoint carrying the count accumulated since the last report.
  // Keyed by provider IDENTITY, not by the redacted label: two differently-keyed
  // endpoints on the same origin both render as `https://host/***`, so a
  // label-keyed map would let one endpoint's counter and one-minute suppression
  // window swallow the other's first warning. (codex P2.)
  const failoverCount = new Map<JsonRpcProvider, number>()
  const failoverLoggedAt = new Map<JsonRpcProvider, number>()
  const FAILOVER_LOG_MS = 60_000
  const reportFailover = (block: number, provider: JsonRpcProvider, err: unknown) => {
    const label = urlLabelOf.get(provider) ?? '<unknown>'
    const n = (failoverCount.get(provider) ?? 0) + 1
    failoverCount.set(provider, n)
    const last = failoverLoggedAt.get(provider)
    const now = Date.now()
    if (last !== undefined && now - last < FAILOVER_LOG_MS) return
    failoverLoggedAt.set(provider, now)
    // Scrub the message too, not just the label: ethers embeds the full
    // requestUrl (userinfo/path/query) in HTTP failure text. Redact BEFORE
    // slicing so a truncation can never expose a half-masked credential.
    const msg = safeErr(err)
    console.warn(`${TAG} ⚠ RPC failover: ${label} failed block ${block} (${n} failure(s) so far) — ${msg.slice(0, 160)}`)
  }
  // Tip and reorg reads were pinned to providers[0] with neither failover nor a
  // timeout. A throttled endpoint does not error — it HANGS, and because these
  // two calls gate EVERY batch, one slow endpoint stalled the whole indexer.
  // Measured on BNB after PR #91: ~85s of each stalled window went here while
  // in-block time stayed normal and the transfer queue sat empty. They now
  // rotate across the pool and time out. Reads are pure, so retrying is safe.
  const RPC_READ_TIMEOUT_MS = parseInt(process.env.RPC_READ_TIMEOUT_MS ?? '10000', 10)
  // Rotates the starting endpoint per call so a throttled one isn't re-tried
  // first every batch (which would pay the timeout before failing over).
  let readCursor = 0
  const readFailCount = new Map<JsonRpcProvider, number>()
  const readLoggedAt = new Map<JsonRpcProvider, number>()
  const reportReadFailover = (provider: JsonRpcProvider, err: unknown) => {
    const label = urlLabelOf.get(provider) ?? '<unknown>'
    const n = (readFailCount.get(provider) ?? 0) + 1
    readFailCount.set(provider, n)
    const last = readLoggedAt.get(provider)
    const now = Date.now()
    if (last !== undefined && now - last < FAILOVER_LOG_MS) return
    readLoggedAt.set(provider, now)
    console.warn(`${TAG} ⚠ RPC read failover: ${label} (${n} so far) — ${safeErr(err).slice(0, 160)}`)
  }
  // Shared across reads AND block fetches so one endpoint's failures inform both.
  // bsc.publicnode.com serves recent blocks but 403s ARCHIVE requests, which only
  // happen once we are already behind — so without this the sick endpoint taxes
  // ~1/N of blocks an 8s timeout exactly when throughput matters most.
  const endpointHealth = createEndpointHealth<JsonRpcProvider>()
  const readTip = () =>
    readWithFailover(providers, readCursor++, p => p.getBlockNumber(), RPC_READ_TIMEOUT_MS, reportReadFailover, endpointHealth)
  // Deps bound to ONE provider. detectReorgPinned fails the whole check over;
  // per-read failover here would mix chain views mid-walk. (codex P1.)
  const reorgDepsFor = (p: JsonRpcProvider) => makeReorgDepsFrom(async n => {
    const b = await p.getBlock(n, false)   // header only
    return b ? { hash: b.hash ?? '', parentHash: b.parentHash } : null
  })
  // A full check can issue up to 2K+2 header reads, so it needs a far longer
  // budget than the single-read tip timeout.
  const REORG_CHECK_TIMEOUT_MS = parseInt(process.env.RPC_REORG_TIMEOUT_MS ?? '45000', 10)
  const db = getDb()

  // Retry getBlockNumber on startup
  let tip = 0
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { tip = await readTip(); break }
    catch (err) {
      console.error(`${TAG} getBlockNumber attempt ${attempt}/5:`, safeErr(err))
      if (attempt < 5) await sleep(5000 * attempt)
      else throw err
    }
  }

  const forceStart = parseInt(process.env.FORCE_START_BLOCK ?? '0', 10)
  let lastIndexed: number
  let resumeGapBackfillUntil: number | null = null

  if (forceStart > 0) {
    lastIndexed = forceStart - 1
    if (ASYNC_TT_WRITER) initTransferWriter(forceStart - 1)
    console.log(`${TAG} FORCE_START_BLOCK=${forceStart} (tip: ${tip})`)
  } else {
    const startBlock = parseInt(process.env.START_BLOCK ?? String(chain.defaultStartBlock), 10)
    const resume = await getResumeCursor(db, startBlock)
    lastIndexed = resume.lastIndexed
    resumeGapBackfillUntil = resume.backfillUntil
    console.log(`${TAG} Resuming from block ${lastIndexed + 1} (tip: ${tip})`)
  }

  // Sync validators only for chains that have them (BNB)
  if (chain.features.hasValidators) {
    syncValidators().catch(err => console.error('[validator-syncer] initial error:', safeErr(err)))
    setInterval(() => syncValidators().catch(err => console.error('[validator-syncer] interval error:', safeErr(err))), 60 * 60 * 1000)
  }

  const MAX_LAG = parseInt(process.env.MAX_LAG_BLOCKS ?? '1000', 10)
  // Consecutive PROVABLY-CLEAN failover failures before a block is stepped over.
  // Lives OUTSIDE the poll loop on purpose: a per-pass tracker would reset every
  // iteration and could never reach the threshold.
  const QUARANTINE_AFTER = positiveIntEnv(process.env.POISON_BLOCK_QUARANTINE_AFTER, DEFAULT_QUARANTINE_AFTER)
  const QUARANTINE_ENABLED = process.env.POISON_BLOCK_QUARANTINE !== '0'
  const poisonBlocks = new PoisonBlockTracker()

  // A3 reorg safety. REORG_CHECK=0 is the kill switch; REORG_DEPTH overrides K.
  const REORG_CHECK = process.env.REORG_CHECK !== '0'
  const REORG_DEPTH = resolveReorgDepth(chain.reorgDepth)
  // The healer's territory rule assumes a reorg can never reach a range the healer
  // owns: the healer only takes gaps older than RESUME_GAP_SCAN_BLOCKS from the tip,
  // and a reorg is bounded at K. Defaults hold that by a wide margin (K = 15 BNB / 3
  // ETH against a 20,000-block separation), but REORG_DEPTH accepts any positive
  // override, and if one ever exceeded the separation, unwindFrom's heal_cursor
  // rewind could race a healer whose lease is still valid — the healer's fenced
  // GREATEST() write would restore the old high cursor and strand the blocks the
  // unwind just deleted beneath it. Assert the relationship rather than leaving it as
  // an unwritten assumption between two modules. (codex P2, follow-up round 3.)
  if (REORG_DEPTH >= RESUME_GAP_SCAN_BLOCKS) {
    throw new Error(
      `${TAG} REORG_DEPTH=${REORG_DEPTH} must stay well below RESUME_GAP_SCAN_BLOCKS=${RESUME_GAP_SCAN_BLOCKS}: ` +
      'a reorg deeper than the resume/healer separation can rewind a heal_cursor out from under a live heal lease.',
    )
  }
  // Throttle the idle (tip-mode) check — it costs 2 header calls; every poll would
  // double idle RPC load for a condition the next boundary check surfaces anyway.
  const IDLE_REORG_CHECK_MS = parseInt(process.env.IDLE_REORG_CHECK_MS ?? '30000', 10)
  let lastIdleReorgCheck = 0
  console.log(`${TAG} reorg tail-check ${REORG_CHECK ? `ON (K=${REORG_DEPTH})` : 'OFF'}`)

  // ── Gap healing ───────────────────────────────────────────────────────────
  // #94 recorded abandoned ranges but nothing ever cleared them, so a range that
  // had been repaired still read `degraded` forever. A signal that can only go
  // red is one people stop reading, which would have cost #94 its entire point.
  //
  // Runs on an interval rather than in the poll loop: the loop's job is the tip,
  // and healing must never sit between it and a new block. healNextGap itself
  // refuses to run while behind (DEFAULT_HEAL_MAX_LAG), because spending RPC on
  // history while lagging drives the loop toward the MAX_LAG skip — which
  // abandons blocks and would manufacture the very gaps this is closing.
  // parseInt would let `GAP_HEAL_BATCH=0` through as a real 0, and `LIMIT 0`
  // returns no missing rows — which IS the healed branch. A single bad env value
  // would stamp healed_at over untouched damage. Every knob here fails open, so
  // all of them are validated rather than trusted. (codex P1.)
  // OFF BY DEFAULT — opt in with GAP_HEAL_ENABLED=1.
  //
  // The healing MACHINERY is complete and verified (atomic fenced claim,
  // retention-bounded, absent-blocks-only, territorially disjoint from the resume
  // scan), but one hole remains and its consequence is disqualifying rather than
  // merely unfortunate. processBlock persists the block and all transactions
  // BEFORE its receipt-derived writes, so if a token/DEX write fails — or the
  // process dies after transfers are enqueued but before the queue drains — the
  // block survives with the expected transaction count. The work set only selects
  // ABSENT blocks, so it will never retry that one, and verification only checks
  // presence and transaction count, so the range can be stamped healed with its
  // transfers, DEX trades and webhooks missing.
  //
  // That turns a VISIBLE gap into invisible partial data reported as
  // `completeness: ok` — a confident false all-clear, which is the exact failure
  // #94 exists to prevent and is strictly worse than having no healer. A missing
  // block you can see beats a wrong block you cannot.
  //
  // Enable once healing has a durable per-block completion marker covering the
  // receipt-derived writes and the transfer drain, or once replay is fully
  // idempotent/transactional. Everything else on this branch is independent of
  // this flag.
  const HEAL_ENABLED = process.env.GAP_HEAL_ENABLED === '1'
  const HEAL_INTERVAL_MS = positiveIntEnv(process.env.GAP_HEAL_INTERVAL_MS, 30000)
  const HEAL_BATCH = positiveIntEnv(process.env.GAP_HEAL_BATCH, DEFAULT_HEAL_BATCH)
  const HEAL_MAX_LAG = positiveIntEnv(process.env.GAP_HEAL_MAX_LAG, DEFAULT_HEAL_MAX_LAG)
  const HEAL_FLUSH_TIMEOUT_MS = positiveIntEnv(process.env.GAP_HEAL_FLUSH_TIMEOUT_MS, 60000)
  // Refreshed every poll iteration AND re-read from the chain at each tick start.
  // The loop-updated value alone goes stale during a long batch or reorg walk, so
  // the healer could start historical work believing a tip that has since moved
  // on — burning the RPC budget precisely when the loop is losing ground.
  let lastKnownTip = tip
  let healInflight = false
  // Fencing identity for the healer's gap lease. healInflight is process-local,
  // and Render rolling deploys overlap generations for ~60-80s, so the claim has
  // to be distinguishable per PROCESS, not per service. (codex P1, round 7.)
  const healOwner = `${process.env.RENDER_INSTANCE_ID ?? 'local'}:${process.pid}:${Date.now().toString(36)}`
  console.log(
    `${TAG} gap healer ${HEAL_ENABLED ? `ON (every ${HEAL_INTERVAL_MS}ms, ${HEAL_BATCH} blk/tick, max lag ${HEAL_MAX_LAG}, owner ${healOwner})` : 'OFF'}`,
  )
  // Printed so the RESOLVED value is verifiable from a boot log rather than
  // inferred from the config literal — env can override it, and this repo has
  // already lost 9 days to trusting a checked-in default over the deployed one.
  console.log(
    `${TAG} poison-block quarantine ${QUARANTINE_ENABLED ? `ON (after ${QUARANTINE_AFTER} clean full-failover failures)` : 'OFF'} (MAX_LAG ${MAX_LAG})`,
  )
  if (HEAL_ENABLED) {
    const healTimer = setInterval(() => {
      // Non-overlapping: a tick that runs long must not stack another on top of
      // it and double the background RPC draw.
      if (healInflight || !running) return
      healInflight = true
      healNextGap(
        {
          db,
          reindexBlock: (blockNumber: number) =>
            processWithFailover(
              blockNumber,
              providers,
              readCursor++,
              (b, p, onSideEffect) => processBlock(b, p, false, onSideEffect),
              reportFailover,
              endpointHealth,
            ),
          // Reads the tip from the CHAIN, not from a closure the poll loop
          // refreshes. A cached tip goes stale exactly when it matters — while
          // the live loop is stuck in a slow batch and the chain moves on — so
          // every lag check the healer makes would keep returning the same
          // reassuring number. Rejecting on RPC failure makes an unknown lag
          // count as "behind" rather than "caught up". (codex P1.)
          readLag: async () => {
            const t = await readTip()
            // Compare against the HIGHEST tip seen, not this one reading. A
            // responsive-but-lagging endpoint can answer with a lower tip than we
            // already know about, and returning `t - lastIndexed` would let that
            // optimistic number green-light healing after a truer reading had
            // already said we were behind. Monotonic is the honest floor.
            // (codex P2, round 3.)
            lastKnownTip = Math.max(lastKnownTip, t)
            return lastKnownTip - lastIndexed
          },
          // Transfers are only ENQUEUED when processBlock returns, and the skip
          // already advanced the durable watermark past this range, so a flush is
          // the only thing that can attest the healed range's transfers landed.
          //
          // BOUNDED, because flushTransferWriter never rejects: the writer catches,
          // requeues and retries forever, so a permanently stuck writer would leave
          // this promise pending, `healInflight` stuck true, and healing silently
          // dead with no error anywhere. A timeout converts that into a refusal to
          // stamp — which is the safe direction, since an undrained queue means the
          // range's transfers may never be replayed. (codex round 3.)
          flushTransfers: ASYNC_TT_WRITER
            ? () => withTimeout(flushTransferWriter(), HEAL_FLUSH_TIMEOUT_MS, 'gap-healer transfer flush')
            : undefined,
          owner: healOwner,
          resumeWindow: RESUME_GAP_SCAN_BLOCKS,
          log: msg => console.log(`${TAG} ${msg}`),
        },
        HEAL_BATCH,
        HEAL_MAX_LAG,
      )
        .catch(err => console.error(`${TAG} gap healer error:`, safeErr(err)))
        .finally(() => { healInflight = false })
    }, HEAL_INTERVAL_MS)
    // Don't hold the process open on shutdown.
    healTimer.unref?.()
  }

  // Roll back the transfer writer FIRST (quiesce in-flight drain, purge stale
  // queue, rewind + persist W to the fork) so the writer can't re-insert orphaned
  // rows after the delete and a crash mid-reprocess can't resume past the fork;
  // then unwind; then let the loop reindex from the fork point.
  const recoverFromReorg = async (forkPoint: number) => {
    console.warn(`${TAG} ⚠ REORG: rolling back to fork point ${forkPoint} (depth ${lastIndexed - forkPoint})`)
    if (ASYNC_TT_WRITER) await rollbackTransferWriterTo(forkPoint)
    await unwindFrom(forkPoint + 1)
    lastIndexed = forkPoint
    // Poison counts are keyed on HEIGHT and this line moves the cursor BACKWARDS,
    // so every count above the fork now describes a block that no longer exists.
    // Left in place they would be charged to the canonical replacements: 4 clean
    // failures against the orphaned block at H plus ONE transient failure against
    // its replacement would quarantine a perfectly good block.
    const clearedPoison = poisonBlocks.clearAbove(forkPoint)
    if (clearedPoison > 0) {
      console.log(`${TAG} reorg cleared ${clearedPoison} poison-block count(s) above ${forkPoint}`)
    }
    // The DURABLE poison rows above the fork are cleared inside unwindFrom(), which
    // runs just above — placed there so a failure THROWS and re-detects the reorg
    // instead of being logged and stepped over. (codex P1, round 4.)
    reportIndexerLag(0)
  }

  /**
   * Decide whether the cursor may step over `blocker`, and record the hole if so.
   *
   * Returns true ONLY when the one-block gap is durably recorded and the block is
   * confirmed absent. The caller advances the cursor on true and does nothing on
   * false — a refusal simply leaves the block pinned and retried, which is the
   * pre-existing behaviour and loses nothing.
   *
   * The absence check is the load-bearing gate, not a belt-and-braces extra. The
   * failure classification that got us here is in-memory, so it cannot know about
   * a half-write left by a PREVIOUS process generation — and Render overlaps deploy
   * generations by 60-80s, so the indexer genuinely meets that state. Quarantining
   * a block whose row already exists would record a gap the healer can never act on
   * (its work set is ABSENT blocks only) over a block that reads as present with
   * the right tx_count and no transfers: invisible bad data, permanently.
   */
  /**
   * Is this height already recorded as an unhealed poison gap?
   *
   * Queried rather than cached: another deploy generation may have recorded it,
   * and a stale in-memory set would refuse the very re-skip that unwedges the
   * cursor. Only ever runs on the failure path, and only while a backfill is
   * active, so it costs nothing on the common path. Fails CLOSED — an unreadable
   * answer is treated as "not recorded", which merely declines the exception and
   * leaves the pre-existing (safe) refusal in place.
   */
  const isRecordedPoisonGap = async (blocker: number): Promise<boolean> => {
    try {
      return await isPoisonBlock(db, blocker)
    } catch (err) {
      console.error(`${TAG} could not check poison-block record for ${blocker}:`, safeErr(err))
      return false
    }
  }

  const tryQuarantine = async (blocker: number, failures: number): Promise<boolean> => {
    // ONE statement: the absence test and the insert are the same operation.
    // Splitting them leaves a window in which the overlapping deploy generation
    // crosses its first write, and a gap recorded over a partially-persisted block
    // is unhealable AND invisible. Also upholds the bulk skip's invariant — the
    // cursor never advances past a range we failed to RECORD.
    try {
      const recorded = await recordPoisonGapIfAbsent(db, blocker, poisonGapReason(QUARANTINE_AFTER), failures)
      if (recorded) return true
    } catch (err) {
      console.error(`${TAG} ⚠ could NOT record poison block ${blocker} — NOT skipping, will retry:`, safeErr(err))
      return false
    }

    // Nothing recorded means the WHERE NOT EXISTS failed: the block's row is
    // present while the cursor still sits below it, so it is partially persisted —
    // almost certainly by an `aborted-dirty` failover. Stepping over it is the
    // invisible-bad-data case. Retrying it is the right move and now actually
    // converges: PR #96 made processBlock replay-safe (dedupable dex_trades via the
    // partial unique on (tx_hash, log_index), set-verified receipt coverage,
    // once-only webhooks), so a replay repairs the missing derived rows rather than
    // duplicating the ones already there.
    poisonBlocks.forget(blocker)
    console.error(`${TAG} ⚠ refusing to quarantine block ${blocker} — its row already EXISTS (partially persisted); retrying instead, replay is safe`)
    return false
  }

  while (running) {
    try {
      const latest = await readTip()
      // Feeds the gap healer's lag guard. Without this it would read a boot-time
      // tip forever and think it was caught up while falling behind.
      //
      // MONOTONIC: a bare assignment lets a lagging endpoint erase a higher tip we
      // already observed, and the healer would then be green-lit by the lower
      // number while genuinely behind. Keeping the high-water mark makes the lag
      // estimate conservative, which is the correct direction for a guard whose
      // job is to refuse work. (codex P2, round 4.)
      lastKnownTip = Math.max(lastKnownTip, latest)

      if (latest <= lastIndexed) {
        // Caught up. Periodically verify the tip we stored is still canonical —
        // catches an in-place tail replacement that a boundary check can't see
        // until the next block arrives.
        if (REORG_CHECK && Date.now() - lastIdleReorgCheck >= IDLE_REORG_CHECK_MS) {
          lastIdleReorgCheck = Date.now()
          const check = await detectReorgPinned(providers, readCursor++, reorgDepsFor, lastIndexed, REORG_DEPTH, REORG_CHECK_TIMEOUT_MS, reportReadFailover, endpointHealth)
          if (check.isReorg) { await recoverFromReorg(check.forkPoint); continue }
        }
        await sleep(POLL_MS)
        continue
      }

      if (resumeGapBackfillUntil !== null && lastIndexed >= resumeGapBackfillUntil) {
        console.log(`${TAG} Resume gap backfill complete through block ${resumeGapBackfillUntil}`)
        resumeGapBackfillUntil = null
      }

      if (resumeGapBackfillUntil === null && latest - lastIndexed > MAX_LAG) {
        const abandonedFrom = lastIndexed + 1
        const abandonedTo = latest - 200
        console.warn(`${TAG} ⚠ ${latest - lastIndexed} blocks behind (>${MAX_LAG}) — ABANDONING blocks ${abandonedFrom}..${abandonedTo} and skipping to ${abandonedTo}`)
        // Record the range before moving the cursor. This skip has always existed
        // and always recorded nothing, so falling behind cost CORRECTNESS, not just
        // freshness — and silently: ~92,000 blocks between 2026-08-04 and 08-11
        // while /api/health reported "ok". Recording makes it alertable now and
        // backfillable later. Failure to record must not stop the skip (the skip is
        // what stops the death spiral), so it is logged and swallowed.
        // The cursor must NOT advance past blocks we failed to record. Logging
        // and skipping anyway would abandon them AND leave them untracked —
        // precisely the silent loss this whole mechanism exists to prevent, so
        // one transient DB blip would reproduce the original bug. (codex P1.)
        //
        // Not skipping is cheap: if the DB is unreachable the indexer cannot
        // write blocks either, so it makes no progress regardless. Leaving the
        // cursor put simply retries the skip on the next iteration, and the
        // >MAX_LAG condition is still true. A no-op return (empty range) is not
        // a failure and does not block.
        let gapRecorded = true
        try {
          await recordIndexGap(db, abandonedFrom, abandonedTo, `max_lag_skip(${MAX_LAG})`)
        } catch (err) {
          gapRecorded = false
          console.error(`${TAG} ⚠ could NOT record index gap ${abandonedFrom}..${abandonedTo} — NOT skipping, will retry:`, safeErr(err))
        }
        if (!gapRecorded) {
          await sleep(1000)
          continue
        }
        lastIndexed = latest - 200
        // Jump the transfer watermark with the skip — these blocks are deliberately
        // abandoned (same gap the pre-existing skip already creates in `blocks`), so
        // the watermark must not stay stuck waiting for transfers that never come.
        if (ASYNC_TT_WRITER) setDurableFloor(latest - 200)
      }

      // A3: validate the batch boundary before processing — detects any reorg at or
      // below lastIndexed (1 header call; the K-bounded walk only runs on mismatch).
      if (REORG_CHECK) {
        const check = await detectReorgPinned(providers, readCursor++, reorgDepsFor, lastIndexed, REORG_DEPTH, REORG_CHECK_TIMEOUT_MS, reportReadFailover, endpointHealth)
        if (check.isReorg) { await recoverFromReorg(check.forkPoint); continue }
      }

      const from = lastIndexed + 1
      const to   = Math.min(from + BATCH_SIZE - 1, latest)

      // Worker-pool pattern — CONCURRENCY persistent workers each pull the
      // next unclaimed block from the batch. When a fast block finishes, the
      // worker picks the next block IMMEDIATELY instead of waiting for the
      // slowest block in the chunk to finish.
      //
      // Previous implementation chunked blocks into groups of CONCURRENCY and
      // did Promise.allSettled per chunk. On BNB a dense DeFi block can take
      // 3-5× longer than an empty block (hundreds of token_transfers + dex_trades
      // to insert). The chunked version stalled 7 workers waiting for 1 slow
      // block, collapsing effective throughput.
      //
      // After this change: workers stay busy. Measured: head-of-line wait
      // eliminated; blk/s approaches the true per-worker rate × CONCURRENCY.
      const total = to - from + 1
      // 0 = pending, 1 = in-flight, 2 = done, 3 = failed
      const blockStatus = new Uint8Array(total)
      // Initialized via cast: workers assign it inside closures, which outer
      // control-flow analysis cannot see — a bare `= null` pins the outer read
      // at line ~305 to type `null` under strictNullChecks.
      let failure = null as { block: number; err: unknown } | null
      let nextIdx = 0
      let windowStart = Date.now()
      let windowBlocks = 0

      const claimNext = (): number => {
        while (nextIdx < total && blockStatus[nextIdx] !== 0) nextIdx++
        if (nextIdx >= total) return -1
        const idx = nextIdx++
        blockStatus[idx] = 1
        return idx
      }

      const advanceLastIndexed = () => {
        // Advance lastIndexed through consecutive done slots from the start,
        // stopping at the first not-done slot. Guarantees monotonic progression
        // and never skips a failed/inflight block.
        const before = lastIndexed
        for (let i = lastIndexed + 1 - from; i < total; i++) {
          if (blockStatus[i] === 2) {
            lastIndexed = from + i
          } else {
            break
          }
        }
        const delta = lastIndexed - before
        if (delta === 0) return
        windowBlocks += delta
        reportIndexerLag(latest - lastIndexed)
        if (lastIndexed % LOG_EVERY === 0 || lastIndexed === to) {
          const elapsed = Date.now() - windowStart
          const bps = elapsed > 0 ? (windowBlocks / (elapsed / 1000)).toFixed(2) : '?'
          let ttInfo = ''
          if (ASYNC_TT_WRITER) {
            const q = getTransferQueueDepth()
            ttInfo = ` | tt:W=${q.durableBlock} q=${q.blocks}blk/${q.rows}rows`
          }
          console.log(`${TAG} Indexed block ${lastIndexed} (tip: ${latest}, lag: ${latest - lastIndexed}, ${bps} blk/s)${ttInfo}`)
          windowStart = Date.now()
          windowBlocks = 0
        }
      }

      await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, workerId) => {
          while (running && failure === null) {
            // Backpressure: don't let block decoding outrun the transfer writer.
            // Bounds memory (OOM history) and the W↔tip replay window on crash.
            if (ASYNC_TT_WRITER) {
              // Throttle on EITHER bound: pending rows (busy ranges) OR pending block
              // count (transfer-less ranges where rows stays ~0 but the pending Map
              // grows unbounded if the writer stalls — codex P2 from PR #43/#44).
              while (running && failure === null) {
                const q = getTransferQueueDepth()
                if (q.rows <= TT_QUEUE_HIGH_WATER_ROWS && q.blocks <= TT_QUEUE_HIGH_WATER_BLOCKS) break
                await sleep(20)
              }
            }
            const idx = claimNext()
            if (idx < 0) return
            const blockNum = from + idx
            // Start on this worker's endpoint (preserves the old round-robin
            // spread), but fail over to the others before giving up. Without
            // this, ONE endpoint that rejects a request class — e.g. an archive
            // 403, which only ever hits us once we're already behind — aborts
            // the whole batch and turns a small lag into a permanent skip.
            try {
              await processWithFailover(
                blockNum,
                providers,
                workerId,
                (b, p, onSideEffect) => processBlock(b, p, false, onSideEffect),
                reportFailover,
                endpointHealth,
              )
              blockStatus[idx] = 2
              // Proves this block is not poison, whatever it did on earlier passes.
              poisonBlocks.recordSuccess(blockNum)
              advanceLastIndexed()
            } catch (err) {
              blockStatus[idx] = 3
              // Only a failure that provably exhausted EVERY endpoint without
              // writing is evidence the block is unindexable. An `aborted-dirty`
              // throw means one endpoint began writing and failover stopped — the
              // block is half-written, which the gap healer can never repair — and
              // `unknown` means the error never came from failover at all. Both
              // reset the count rather than advancing it, so a block can only
              // reach the threshold through an unbroken run of clean exhaustions.
              if (failoverKind(err) === 'exhausted-clean') poisonBlocks.recordCleanFailure(blockNum)
              else poisonBlocks.recordUnclean(blockNum)
              if (!failure) failure = { block: blockNum, err }
              return
            }
          }
        })
      )

      if (failure) {
        // Same leak as the failover logger: ethers puts the full requestUrl in
        // the message, and this line is how raw endpoints reached production
        // logs before redaction existed. Scrub it here too.
        console.error(`${TAG} Block ${failure.block} failed:`, safeErr(failure.err))

        // QUARANTINE the one block that is pinning the cursor.
        //
        // Left alone it pins `lastIndexed` while the chain advances, and once lag
        // crosses MAX_LAG the bulk skip above abandons everything through
        // `latest - 200`: ~4,800 blocks discarded because of one, nearly all of
        // them perfectly indexable. A recorded ONE-block gap keeps the loss
        // proportional to the actual damage.
        const blocker = lastIndexed + 1
        if (
          QUARANTINE_ENABLED &&
          shouldQuarantine(blocker, lastIndexed, poisonBlocks.count(blocker), QUARANTINE_AFTER) &&
          // The same guard the bulk MAX_LAG skip carries: during a resume gap
          // backfill the indexer is DELIBERATELY replaying an old range, so
          // `lastIndexed + 1` is a block being re-indexed rather than the live
          // frontier, and stepping over it would advance the cursor — and the
          // watermark with it — through a range mid-replay.
          //
          // The exception is load-bearing. A block ALREADY recorded as a poison gap
          // has had its skip decision made durably; re-applying it creates no new
          // hole. Without the exception the guard is the deadlock: a quarantined
          // block is absent, an absent block can put the next boot into backfill,
          // and a backfill that refuses to re-skip pins the cursor on the one block
          // proven unindexable, with the bulk skip disabled by the same condition.
          (resumeGapBackfillUntil === null || await isRecordedPoisonGap(blocker))
        ) {
          const failures = poisonBlocks.count(blocker)
          if (await tryQuarantine(blocker, failures)) {
            // Note: the cursor now sits on a deliberately ABSENT block, so the next
            // boundary reorg check no-ops (detect-reorg treats a missing stored hash
            // as "nothing to validate"). The blind spot is exactly one iteration —
            // the next successfully indexed block restores it — and it is the same
            // behaviour the bulk MAX_LAG skip has always had, since it also lands the
            // cursor on a block it never indexed. findForkPoint already skips missing
            // rows, so a reorg walk across the hole still resolves.
            console.warn(`${TAG} ⚠ QUARANTINING block ${blocker} after ${failures} clean full-failover failures — recorded as a 1-block gap, advancing past it`)
            lastIndexed = blocker
            // Move the transfer watermark with a QUARANTINE batch, not with
            // setDurableFloor() and not with an empty ordinary batch.
            //
            // setDurableFloor jumps W unconditionally. That is fine for the bulk
            // MAX_LAG skip, which leaps to `latest - 200` over blocks nothing has
            // touched, but it is wrong here: quarantine steps over `lastIndexed + 1`,
            // directly above blocks the indexer just finished. Workers advance
            // lastIndexed when processBlock RETURNS and processBlock only ENQUEUES
            // transfers, so blocks below the blocker are routinely written-but-
            // undrained. Jumping W over them would claim their rows are durable while
            // they sit in the queue, and a crash there loses them permanently —
            // crash-resume replays only from W upward.
            //
            // An ordinary empty batch would be wrong, and dangerously so:
            // writeTransferBlocks DELETEs every block it drains, so an empty batch is
            // empty-by-OMISSION and would delete rows it never decoded. That is the
            // same failure that lost data on `--skip-logs` backfills (PR #42, and the
            // warning above the enqueue in processBlock). The window is real here —
            // the batch can sit in the 250ms requeue-retry loop, or in an outgoing
            // deploy generation, while a heal writes this block's real transfers.
            //
            // A quarantine batch makes no claim about the block: never deleted, never
            // inserted, so a stale retry is a complete no-op. It only contributes its
            // height, which lands in `transferWritten` so the EXISTING contiguous-
            // prefix fold carries W past it once everything beneath has committed.
            // Revocation stays automatic — a real decode replaces the entry under the
            // usual "latest decode of a block wins" rule.
            //
            // The fold itself is untouched. An earlier design folded quarantined
            // heights through a SECOND set alongside transferWritten, and codex found
            // a fresh P1 in that fold on each of two review rounds — the revocation
            // race, then the re-validation race in its fix. The flag here rides inside
            // the queued batch, so there is no parallel state to drift.
            if (ASYNC_TT_WRITER) enqueueQuarantinedBlock(blocker)
            poisonBlocks.forget(blocker)
          }
        }
        await sleep(1000)
      }

      // Bound the tracker: counts for blocks the cursor has passed can never be
      // acted on again, and without this the map grows for the process lifetime.
      poisonBlocks.prune(lastIndexed)

      if (lastIndexed >= latest) await sleep(POLL_MS)
    } catch (err) {
      console.error(`${TAG} Error:`, safeErr(err))
      await sleep(5000)
    }
  }

  // Drain the async transfer writer so in-flight transfers persist + the watermark
  // advances before exit. Best-effort: if SIGKILL beats us, the watermark guarantees
  // the next boot replays [W+1..] with no gap.
  if (ASYNC_TT_WRITER) {
    console.log(`${TAG} draining transfer writer before exit...`)
    await flushTransferWriter()
  }
  console.log(`${TAG} Stopped.`)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getResumeCursor(
  db: ReturnType<typeof getDb>,
  startBlock: number,
): Promise<{ lastIndexed: number; backfillUntil: number | null }> {
  const row = await db.select({ number: schema.blocks.number })
    .from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(1)
  const maxIndexed = row[0]?.number
  if (maxIndexed === undefined) {
    // Empty DB — seed the transfer watermark to the same fresh-start floor.
    if (ASYNC_TT_WRITER) initTransferWriter(startBlock - 1)
    return { lastIndexed: startBlock - 1, backfillUntil: null }
  }

  // Block-row gap scan over the recent window (heals holes in `blocks`).
  const scanFrom = Math.max(startBlock, maxIndexed - RESUME_GAP_SCAN_BLOCKS)
  const gapResult = await db.execute(sql`
    WITH expected AS (
      SELECT generate_series(${scanFrom}::bigint, ${maxIndexed}::bigint) AS number
    )
    SELECT MIN(expected.number)::bigint AS missing
    FROM expected
    LEFT JOIN blocks ON blocks.number = expected.number
    WHERE blocks.number IS NULL
      -- Exclude blocks we DELIBERATELY abandoned as poison. Without this the scan
      -- cannot tell a quarantine from an accidental hole, so it rewinds the cursor
      -- onto the one block already proven unindexable and sets backfillUntil — which
      -- disables BOTH the quarantine guard and the bulk MAX_LAG skip. The cursor then
      -- pins on that block and backfillUntil can only clear by passing it, so the
      -- indexer wedges permanently on the next restart, with every safety valve off.
      -- Quarantine would have manufactured exactly that state. (codex P1, round 1.)
      --
      -- Keyed on poison_blocks, NOT on index_gaps.reason. Gap rows are keyed by
      -- from_block and merge on conflict, so an unrelated max_lag_skip starting at the
      -- same height would overwrite the reason and silently un-recognise the
      -- quarantine — reintroducing the deadlock with no error anywhere. A poison
      -- height is its own row and nothing merges into it. (codex P1, round 2.)
      AND NOT EXISTS (
        SELECT 1 FROM poison_blocks p WHERE p.block_number = expected.number
      )
  `)
  const missingRaw = (Array.from(gapResult)[0] as Record<string, unknown> | undefined)?.missing
  let base: { lastIndexed: number; backfillUntil: number | null }
  if (missingRaw !== null && missingRaw !== undefined) {
    const missing = Number(missingRaw)
    console.warn(`${TAG} Resume gap detected at block ${missing}; backfilling before tip ${maxIndexed}`)
    base = { lastIndexed: missing - 1, backfillUntil: maxIndexed }
  } else {
    base = { lastIndexed: maxIndexed, backfillUntil: null }
  }

  if (!ASYNC_TT_WRITER) return base

  // Async writer: resume from the LOWER of the block cursor and the durable
  // transfer watermark W. token_transfers are only guaranteed present for blocks
  // ≤ W, so any block in (W, maxIndexed] must be re-processed to idempotently
  // re-write its transfers. Seed the writer with W so it advances from there.
  const W = await getOrInitDurableBlock(db, maxIndexed)
  initTransferWriter(W)

  // No quarantine state is restored here, and none needs to be.
  //
  // An earlier design kept quarantined heights in an in-memory set that the fold
  // consulted, so a restart lost them and W could strand below a deliberately-absent
  // block forever — which forced a restoration pass, which codex then found could
  // mark a height whose block was no longer absent. Enqueuing an empty batch removes
  // the whole problem: W only advances past a quarantined height AFTER that empty
  // batch has been written and folded, so the state is either already durable in W or
  // simply not yet applied.
  //
  // The not-yet-applied case self-heals. Resuming from min(cursor, W) replays the
  // block, it fails again, and it is re-quarantined — permitted even mid-backfill
  // because the gap is already recorded (see the guard in the poll loop).
  const lastIndexed = Math.min(base.lastIndexed, W)
  // When replaying un-durable transfers up to maxIndexed, suppress the MAX_LAG
  // skip until we've caught back up — otherwise the skip would floor past the
  // un-durable range and leave a permanent transfer gap.
  const backfillUntil = lastIndexed < maxIndexed
    ? Math.max(base.backfillUntil ?? 0, maxIndexed)
    : base.backfillUntil
  if (lastIndexed < maxIndexed) {
    console.warn(`${TAG} transfer watermark W=${W} < maxIndexed=${maxIndexed}; replaying transfers [${lastIndexed + 1}..${maxIndexed}]`)
  }
  return { lastIndexed, backfillUntil }
}

/**
 * Read indexer_cursor.transfers_durable_block (the async writer's watermark W).
 * On first run the row is 0/absent — initialize W to maxIndexed, because every
 * block already in `blocks` had its transfers written by the old synchronous code.
 */
async function getOrInitDurableBlock(
  db: ReturnType<typeof getDb>,
  maxIndexed: number,
): Promise<number> {
  const res = await db.execute(sql`SELECT transfers_durable_block FROM indexer_cursor WHERE id = 1`)
  const raw = (Array.from(res)[0] as Record<string, unknown> | undefined)?.transfers_durable_block
  const stored = raw === null || raw === undefined ? 0 : Number(raw)
  if (stored > 0) return stored
  // Fresh cursor — adopt maxIndexed as the durable floor (old sync-code guarantee).
  await db.execute(sql`
    INSERT INTO indexer_cursor (id, transfers_durable_block) VALUES (1, ${maxIndexed})
    ON CONFLICT (id) DO UPDATE SET transfers_durable_block = ${maxIndexed}
  `)
  console.log(`${TAG} initialized transfers_durable_block = ${maxIndexed}`)
  return maxIndexed
}

main().catch(err => {
  console.error(`${TAG} Fatal:`, safeErr(err))
  process.exit(1)
})
