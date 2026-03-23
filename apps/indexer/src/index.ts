import 'dotenv/config'
import { startBlockIndexer } from './block-indexer'
import { Worker, connection } from './queue'  // static import — never use dynamic import()
import { processBlock } from './block-processor'
import { processLogs } from './log-processor'
import { syncValidators } from './validator-syncer'
import { startRetentionCleanup } from './retention-cleanup'

async function main() {
  console.log('[indexer] Starting BNBScan indexer...')

  // 90-day retention cleanup — runs once at startup then every 24h
  startRetentionCleanup()

  // Block processor worker
  const blockWorker = new Worker('blocks', async (job) => {
    await processBlock(job.data.blockNumber, job.data.skipLogs ?? false)
  }, { connection, concurrency: 5 })
  blockWorker.on('error', err => console.error('[block-worker] error:', err))

  // Log processor worker
  const logWorker = new Worker('logs', async (job) => {
    await processLogs(job.data.txHash, job.data.blockNumber, new Date(job.data.timestamp))
  }, { connection, concurrency: 10 })
  logWorker.on('error', err => console.error('[log-worker] error:', err))

  // Sync validators every 10 minutes
  setInterval(() => syncValidators().catch(err => console.error('[validator-syncer] interval error:', err)), 10 * 60 * 1000)
  await syncValidators()

  // Start main polling loop
  await startBlockIndexer()
}

main().catch(err => {
  console.error('[indexer] Fatal error:', err)
  process.exit(1)
})
