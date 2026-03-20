import 'dotenv/config'
import { startBlockIndexer } from './block-indexer'
import { Worker, connection } from './queue'  // static import — never use dynamic import()
import { processBlock } from './block-processor'
import { processLogs } from './log-processor'
import { syncValidators } from './validator-syncer'

async function main() {
  console.log('[indexer] Starting BNBScan indexer...')

  // Block processor worker
  new Worker('blocks', async (job) => {
    await processBlock(job.data.blockNumber)
  }, { connection, concurrency: 5 })

  // Log processor worker
  new Worker('logs', async (job) => {
    await processLogs(job.data.txHash, job.data.blockNumber, new Date(job.data.timestamp))
  }, { connection, concurrency: 10 })

  // Sync validators every 10 minutes
  setInterval(() => syncValidators(), 10 * 60 * 1000)
  await syncValidators()

  // Start main polling loop
  await startBlockIndexer()
}

main().catch(err => {
  console.error('[indexer] Fatal error:', err)
  process.exit(1)
})
