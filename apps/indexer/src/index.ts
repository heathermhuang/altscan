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
import { getChainConfig } from '@bnbscan/chain-config'
import { processBlock } from './block-processor'
import { syncValidators } from './validator-syncer'
import { startRetentionCleanup } from './retention-cleanup'
import { ensureSchema } from './ensure-schema'
import { getDb, schema } from './db'
import { desc } from 'drizzle-orm'

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

  if (forceStart > 0) {
    lastIndexed = forceStart - 1
    console.log(`${TAG} FORCE_START_BLOCK=${forceStart} (tip: ${tip})`)
  } else {
    const row = await db.select({ number: schema.blocks.number })
      .from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(1)
    lastIndexed = row[0]?.number ?? (parseInt(process.env.START_BLOCK ?? String(chain.defaultStartBlock), 10) - 1)
    console.log(`${TAG} Resuming from block ${lastIndexed + 1} (tip: ${tip})`)
  }

  // Sync validators only for chains that have them (BNB)
  if (chain.features.hasValidators) {
    syncValidators().catch(err => console.error('[validator-syncer] initial error:', err))
    setInterval(() => syncValidators().catch(err => console.error('[validator-syncer] interval error:', err)), 60 * 60 * 1000)
  }

  const MAX_LAG = parseInt(process.env.MAX_LAG_BLOCKS ?? '1000', 10)

  while (running) {
    try {
      const latest = await tipProvider.getBlockNumber()

      if (latest <= lastIndexed) {
        await sleep(POLL_MS)
        continue
      }

      if (latest - lastIndexed > MAX_LAG) {
        console.log(`${TAG} ${latest - lastIndexed} blocks behind (>${MAX_LAG}) — skipping to block ${latest - 200}`)
        lastIndexed = latest - 200
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
      let failure: { block: number; err: unknown } | null = null
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
        if (lastIndexed % LOG_EVERY === 0 || lastIndexed === to) {
          const elapsed = Date.now() - windowStart
          const bps = elapsed > 0 ? (windowBlocks / (elapsed / 1000)).toFixed(2) : '?'
          console.log(`${TAG} Indexed block ${lastIndexed} (tip: ${latest}, lag: ${latest - lastIndexed}, ${bps} blk/s)`)
          windowStart = Date.now()
          windowBlocks = 0
        }
      }

      await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, workerId) => {
          while (running && failure === null) {
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

  console.log(`${TAG} Stopped.`)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error(`${TAG} Fatal:`, err)
  process.exit(1)
})
