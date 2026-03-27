/**
 * BNB Chain block indexer — direct polling loop, no Redis/BullMQ required.
 *
 * Env vars:
 *   BNB_RPC_URL        — BSC JSON-RPC endpoint (default: https://bsc-dataseed1.binance.org/)
 *   DATABASE_URL       — PostgreSQL connection string
 *   START_BLOCK        — Block to start from if DB is empty (default: 38000000)
 *   FORCE_START_BLOCK  — Override DB resume and start from this block regardless
 *   LOG_EVERY          — Log progress every N blocks (default: 10)
 */
import 'dotenv/config'
import { JsonRpcProvider } from 'ethers'
import { processBlock } from './block-processor'
import { syncValidators } from './validator-syncer'
import { startRetentionCleanup } from './retention-cleanup'
import { ensureSchema } from './ensure-schema'
import { getDb, schema } from '@bnbscan/db'
import { desc } from 'drizzle-orm'

const RPC_URL     = process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/'
const POLL_MS     = 3_000
const BATCH_SIZE  = 20   // fetch up to 20 blocks per iteration when catching up
const CONCURRENCY = parseInt(process.env.INDEX_CONCURRENCY ?? '3', 10)  // parallel block workers
const LOG_EVERY   = parseInt(process.env.LOG_EVERY ?? '50', 10)

let running = true
process.on('SIGINT',  () => { running = false })
process.on('SIGTERM', () => { running = false })
process.on('unhandledRejection', (err) => {
  console.error('[indexer] Unhandled rejection:', err)
})
process.on('uncaughtException', (err) => {
  console.error('[indexer] Uncaught exception:', err)
  process.exit(1)
})

async function main() {
  console.log('[indexer] Starting BNBScan indexer (no-Redis mode)...')
  console.log(`[indexer] RPC: ${RPC_URL.replace(/\/\/.*@/, '//***@')}`)

  await ensureSchema()
  // Run retention cleanup in background — don't block startup
  startRetentionCleanup().catch(err => console.error('[indexer] retention startup error:', err))

  const provider = new JsonRpcProvider(RPC_URL)
  const db = getDb()

  // Retry getBlockNumber on startup
  let tip = 0
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { tip = await provider.getBlockNumber(); break }
    catch (err) {
      console.error(`[indexer] getBlockNumber attempt ${attempt}/5:`, err instanceof Error ? err.message : err)
      if (attempt < 5) await sleep(5000 * attempt)
      else throw err
    }
  }

  const forceStart = parseInt(process.env.FORCE_START_BLOCK ?? '0', 10)
  let lastIndexed: number

  if (forceStart > 0) {
    lastIndexed = forceStart - 1
    console.log(`[indexer] FORCE_START_BLOCK=${forceStart} (tip: ${tip})`)
  } else {
    const row = await db.select({ number: schema.blocks.number })
      .from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(1)
    lastIndexed = row[0]?.number ?? (parseInt(process.env.START_BLOCK ?? '38000000', 10) - 1)
    console.log(`[indexer] Resuming from block ${lastIndexed + 1} (tip: ${tip})`)
  }

  // Sync validators every 10 min
  syncValidators().catch(err => console.error('[validator-syncer] initial error:', err))
  setInterval(() => syncValidators().catch(err => console.error('[validator-syncer] interval error:', err)), 10 * 60 * 1000)

  // Auto-skip: if too far behind, jump to near chain tip.
  // A block explorer with stale data is useless — better to show recent blocks
  // than grind through days of backlog.
  const MAX_LAG = parseInt(process.env.MAX_LAG_BLOCKS ?? '1000', 10)

  while (running) {
    try {
      const latest = await provider.getBlockNumber()

      if (latest <= lastIndexed) {
        await sleep(POLL_MS)
        continue
      }

      // If we're too far behind, skip ahead to near tip
      if (latest - lastIndexed > MAX_LAG) {
        console.log(`[indexer] ${latest - lastIndexed} blocks behind (>${MAX_LAG}) — skipping to block ${latest - 200}`)
        lastIndexed = latest - 200
      }

      const from = lastIndexed + 1
      const to   = Math.min(from + BATCH_SIZE - 1, latest)

      // Process blocks in parallel batches of CONCURRENCY — much faster catchup
      const blockNums: number[] = []
      for (let n = from; n <= to; n++) blockNums.push(n)

      for (let i = 0; i < blockNums.length && running; i += CONCURRENCY) {
        const chunk = blockNums.slice(i, i + CONCURRENCY)
        await Promise.all(chunk.map(num => processBlock(num, provider)))
        lastIndexed = chunk[chunk.length - 1]
        if (lastIndexed % LOG_EVERY === 0) {
          console.log(`[indexer] Indexed block ${lastIndexed} (tip: ${latest}, lag: ${latest - lastIndexed})`)
        }
      }

      if (lastIndexed >= latest) await sleep(POLL_MS)
    } catch (err) {
      console.error('[indexer] Error:', err instanceof Error ? err.message : err)
      await sleep(5000)
    }
  }

  console.log('[indexer] Stopped.')
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error('[indexer] Fatal:', err)
  process.exit(1)
})
