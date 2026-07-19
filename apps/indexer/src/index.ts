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
  getTransferQueueDepth,
  flushTransferWriter,
  rollbackTransferWriterTo,
  ASYNC_TT_WRITER,
  TT_QUEUE_HIGH_WATER_ROWS,
  TT_QUEUE_HIGH_WATER_BLOCKS,
} from './block-processor'
import { detectReorg, makeReorgDeps, resolveReorgDepth, unwindFrom } from './reorg-handler'
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
const RPC_URLS = (process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const POLL_MS     = chain.pollMs
const BATCH_SIZE  = parseInt(process.env.INDEX_BATCH_SIZE ?? '40', 10)
// BNB produces a block every 3s — needs higher concurrency to keep up.
// ETH at 12s can run lower. Default = 8 for BNB, 4 for ETH.
const DEFAULT_CONCURRENCY = chain.key === 'bnb' ? 8 : 4
const CONCURRENCY = parseInt(process.env.INDEX_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10)
const LOG_EVERY   = parseInt(process.env.LOG_EVERY ?? '50', 10)
const RESUME_GAP_SCAN_BLOCKS = parseInt(process.env.RESUME_GAP_SCAN_BLOCKS ?? '20000', 10)

let running = true
process.on('SIGINT',  () => { running = false })
process.on('SIGTERM', () => { running = false })
process.on('unhandledRejection', (err) => {
  console.error(`${TAG} Unhandled rejection:`, err)
})
process.on('uncaughtException', (err) => {
  console.error(`${TAG} Uncaught exception:`, err)
  process.exit(1)
})

async function main() {
  console.log(`${TAG} Starting ${chain.name} indexer...`)
  const redactedRpcs = RPC_URLS.map(u => u.replace(/\/\/.*@/, '//***@'))
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

  startRetentionCleanup().catch(err => console.error(`${TAG} retention startup error:`, err))

  // Track A4b lazy backfill — gated on chain-config `provider.backfill.enabled`
  // (false on both chains until A4b-2 rollout) + the BACKFILL_ENABLED=0 kill switch.
  startBackfillWorker().catch(err => console.error('[backfill] fatal:', err))

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
  // Tip queries always use providers[0]; keeps the "tip" cursor consistent
  // and doesn't matter for rate-limits (1 req per poll cycle).
  const tipProvider = providers[0]
  const db = getDb()

  // Retry getBlockNumber on startup
  let tip = 0
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { tip = await tipProvider.getBlockNumber(); break }
    catch (err) {
      console.error(`${TAG} getBlockNumber attempt ${attempt}/5:`, err instanceof Error ? err.message : err)
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
    syncValidators().catch(err => console.error('[validator-syncer] initial error:', err))
    setInterval(() => syncValidators().catch(err => console.error('[validator-syncer] interval error:', err)), 60 * 60 * 1000)
  }

  const MAX_LAG = parseInt(process.env.MAX_LAG_BLOCKS ?? '1000', 10)

  // A3 reorg safety. REORG_CHECK=0 is the kill switch; REORG_DEPTH overrides K.
  const REORG_CHECK = process.env.REORG_CHECK !== '0'
  const REORG_DEPTH = resolveReorgDepth(chain.reorgDepth)
  const reorgDeps = makeReorgDeps(tipProvider)
  // Throttle the idle (tip-mode) check — it costs 2 header calls; every poll would
  // double idle RPC load for a condition the next boundary check surfaces anyway.
  const IDLE_REORG_CHECK_MS = parseInt(process.env.IDLE_REORG_CHECK_MS ?? '30000', 10)
  let lastIdleReorgCheck = 0
  console.log(`${TAG} reorg tail-check ${REORG_CHECK ? `ON (K=${REORG_DEPTH})` : 'OFF'}`)

  // Roll back the transfer writer FIRST (quiesce in-flight drain, purge stale
  // queue, rewind + persist W to the fork) so the writer can't re-insert orphaned
  // rows after the delete and a crash mid-reprocess can't resume past the fork;
  // then unwind; then let the loop reindex from the fork point.
  const recoverFromReorg = async (forkPoint: number) => {
    console.warn(`${TAG} ⚠ REORG: rolling back to fork point ${forkPoint} (depth ${lastIndexed - forkPoint})`)
    if (ASYNC_TT_WRITER) await rollbackTransferWriterTo(forkPoint)
    await unwindFrom(forkPoint + 1)
    lastIndexed = forkPoint
    reportIndexerLag(0)
  }

  while (running) {
    try {
      const latest = await tipProvider.getBlockNumber()

      if (latest <= lastIndexed) {
        // Caught up. Periodically verify the tip we stored is still canonical —
        // catches an in-place tail replacement that a boundary check can't see
        // until the next block arrives.
        if (REORG_CHECK && Date.now() - lastIdleReorgCheck >= IDLE_REORG_CHECK_MS) {
          lastIdleReorgCheck = Date.now()
          const check = await detectReorg(reorgDeps, lastIndexed, REORG_DEPTH)
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
        console.log(`${TAG} ${latest - lastIndexed} blocks behind (>${MAX_LAG}) — skipping to block ${latest - 200}`)
        lastIndexed = latest - 200
        // Jump the transfer watermark with the skip — these blocks are deliberately
        // abandoned (same gap the pre-existing skip already creates in `blocks`), so
        // the watermark must not stay stuck waiting for transfers that never come.
        if (ASYNC_TT_WRITER) setDurableFloor(latest - 200)
      }

      // A3: validate the batch boundary before processing — detects any reorg at or
      // below lastIndexed (1 header call; the K-bounded walk only runs on mismatch).
      if (REORG_CHECK) {
        const check = await detectReorg(reorgDeps, lastIndexed, REORG_DEPTH)
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
            const provider = providers[workerId % providers.length]
            try {
              await processBlock(blockNum, provider)
              blockStatus[idx] = 2
              advanceLastIndexed()
            } catch (err) {
              blockStatus[idx] = 3
              if (!failure) failure = { block: blockNum, err }
              return
            }
          }
        })
      )

      if (failure) {
        console.error(`${TAG} Block ${failure.block} failed:`, failure.err instanceof Error ? failure.err.message : failure.err)
        await sleep(1000)
      }

      if (lastIndexed >= latest) await sleep(POLL_MS)
    } catch (err) {
      console.error(`${TAG} Error:`, err instanceof Error ? err.message : err)
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
  console.error(`${TAG} Fatal:`, err)
  process.exit(1)
})
