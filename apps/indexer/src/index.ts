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
import { JsonRpcProvider } from 'ethers'
import { getChainConfig } from '@bnbscan/chain-config'
import { processBlock } from './block-processor'
import { syncValidators } from './validator-syncer'
import { startRetentionCleanup } from './retention-cleanup'
import { ensureSchema } from './ensure-schema'
import { getDb, schema } from './db'
import { desc } from 'drizzle-orm'

const chain = getChainConfig()
const TAG = `[${chain.brandName}-indexer]`

const RPC_URL     = process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl
const POLL_MS     = chain.pollMs
const BATCH_SIZE  = 20
const CONCURRENCY = parseInt(process.env.INDEX_CONCURRENCY ?? '3', 10)
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
  console.log(`${TAG} Chain: ${chain.name} (${chain.key}), RPC: ${RPC_URL.replace(/\/\/.*@/, '//***@')}`)

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

  const provider = new JsonRpcProvider(RPC_URL)
  const db = getDb()

  // Retry getBlockNumber on startup
  let tip = 0
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { tip = await provider.getBlockNumber(); break }
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
      const latest = await provider.getBlockNumber()

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

      const blockNums: number[] = []
      for (let n = from; n <= to; n++) blockNums.push(n)

      for (let i = 0; i < blockNums.length && running; i += CONCURRENCY) {
        const chunk = blockNums.slice(i, i + CONCURRENCY)
        await Promise.all(chunk.map(num => processBlock(num, provider)))
        lastIndexed = chunk[chunk.length - 1]
        if (lastIndexed % LOG_EVERY === 0) {
          console.log(`${TAG} Indexed block ${lastIndexed} (tip: ${latest}, lag: ${latest - lastIndexed})`)
        }
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
