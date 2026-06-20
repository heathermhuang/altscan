import 'dotenv/config'
import { JsonRpcProvider, Network } from 'ethers'
import { getChainConfig } from '@altscan/chain-config'
import {
  processBlock,
  initTransferWriter,
  flushTransferWriter,
  ASYNC_TT_WRITER,
} from './block-processor'

const chain = getChainConfig()

// Usage: CHAIN=bnb node dist/backfill.js <start> <end> [--skip-logs]
const START = Number(process.argv[2] ?? String(chain.defaultStartBlock))
const END = Number(process.argv[3] ?? String(chain.defaultStartBlock + 1000))
const SKIP_LOGS = process.argv.includes('--skip-logs')
const CONCURRENCY = 3

// BNB_RPC_URL / ETH_RPC_URL may be comma-separated — backfill only needs one
// endpoint so we pick the first. staticNetwork: pin chain ID so ethers skips
// eth_chainId auto-detection.
const rpcUrl = (process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)[0] ?? chain.defaultRpcUrl
const network = Network.from(chain.chainId)
const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network })

async function backfill() {
  console.log(`[backfill] Processing blocks ${START}–${END} (${END - START + 1} blocks, skipLogs=${SKIP_LOGS}, concurrency=${CONCURRENCY})`)

  // Async token_transfers writer (block-processor's default for BNB): processBlock
  // ENQUEUES transfers for a background coalescing writer instead of inserting them
  // inline. That writer is inert until seeded — so without this call every backfilled
  // transfer just piles up in memory and is silently dropped at process.exit (the
  // June 2026 tt-writer data-loss incident). Seed at END (top of range), NOT START-1:
  // the writer must persist the rows but must NOT advance/persist
  // indexer_cursor.transfers_durable_block (the shared crash-safe watermark a live
  // indexer reads on restart). Seeding low would drag that watermark backward and
  // force a full replay; seeding at END means no enqueued block exceeds the
  // watermark, so the fold-and-persist step is skipped while rows are still written.
  // Inline path (ETH / ASYNC_TT_WRITER=0) writes synchronously and needs none of this.
  // Skip when SKIP_LOGS: no logs are decoded so there are no transfers to write, and
  // processBlock won't enqueue under skipLogs (see block-processor "3b") — seeding here
  // would spin up a writer with nothing to drain.
  if (ASYNC_TT_WRITER && !SKIP_LOGS) initTransferWriter(END)

  const blocks = Array.from({ length: END - START + 1 }, (_, i) => START + i)
  let done = 0
  let failed = 0

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < blocks.length; i += CONCURRENCY) {
    const chunk = blocks.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(n =>
        processBlock(n, provider, SKIP_LOGS).catch(err => {
          failed++
          console.error(`[backfill] Block ${n} failed:`, err instanceof Error ? err.message : err)
        })
      )
    )
    done += chunk.length
    if (done % 100 === 0 || done === blocks.length) {
      console.log(`[backfill] Progress: ${done}/${blocks.length} (${Math.round(done / blocks.length * 100)}%)`)
    }
  }

  // Drain the async writer so every enqueued transfer is committed to the DB before
  // we exit — process.exit(0) would otherwise discard the in-memory queue. No-op on
  // the inline path. flushTransferWriter resolves only once the queue is empty and
  // the drainer's final DB transaction has landed. Guarded by !SKIP_LOGS to match the
  // seed above (nothing was enqueued under skipLogs, so there is nothing to drain).
  if (ASYNC_TT_WRITER && !SKIP_LOGS) {
    console.log('[backfill] draining transfer writer before exit...')
    await flushTransferWriter()
  }

  // A repair tool must not report success after silently skipping blocks: a per-block
  // failure above means that block's rows (and its transfers) may be missing, so exit
  // non-zero to signal the range needs re-running.
  if (failed > 0) {
    console.error(`[backfill] Done with ${failed}/${blocks.length} block(s) FAILED — re-run the affected range.`)
    process.exit(1)
  }

  console.log('[backfill] Done.')
  process.exit(0)
}

backfill().catch(err => {
  console.error('[backfill] Fatal error:', err)
  process.exit(1)
})
