import 'dotenv/config'
import { JsonRpcProvider } from 'ethers'
import { processBlock } from './block-processor'

// Usage: node dist/backfill.js <start> <end> [--skip-logs]
// --skip-logs: skip receipt/log enrichment (much cheaper — 1 RPC call per block vs 1+txCount)
//              Use for historical backfill. Live blocks should NOT skip logs.
const START = Number(process.argv[2] ?? '38000000')
const END = Number(process.argv[3] ?? '38001000')
const SKIP_LOGS = process.argv.includes('--skip-logs')
const CONCURRENCY = 3  // process N blocks in parallel

const provider = new JsonRpcProvider(process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/')

async function backfill() {
  console.log(`[backfill] Processing blocks ${START}–${END} (${END - START + 1} blocks, skipLogs=${SKIP_LOGS}, concurrency=${CONCURRENCY})`)

  const blocks = Array.from({ length: END - START + 1 }, (_, i) => START + i)
  let done = 0

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < blocks.length; i += CONCURRENCY) {
    const chunk = blocks.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(n =>
        processBlock(n, provider, SKIP_LOGS).catch(err =>
          console.error(`[backfill] Block ${n} failed:`, err instanceof Error ? err.message : err)
        )
      )
    )
    done += chunk.length
    if (done % 100 === 0 || done === blocks.length) {
      console.log(`[backfill] Progress: ${done}/${blocks.length} (${Math.round(done / blocks.length * 100)}%)`)
    }
  }

  console.log('[backfill] Done.')
  process.exit(0)
}

backfill().catch(err => {
  console.error('[backfill] Fatal error:', err)
  process.exit(1)
})
