import 'dotenv/config'
import { blockQueue } from './queue'

const START = Number(process.argv[2] ?? '38000000')
const END = Number(process.argv[3] ?? '38001000')
const BATCH = 100

async function backfill() {
  console.log(`[backfill] Queueing blocks ${START}–${END} (${END - START + 1} blocks)`)

  for (let n = START; n <= END; n += BATCH) {
    const batchEnd = Math.min(n + BATCH - 1, END)
    const jobs = []
    for (let i = n; i <= batchEnd; i++) {
      jobs.push({
        name: 'process-block',
        data: { blockNumber: i },
        opts: { jobId: `block-${i}`, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
      })
    }
    await blockQueue.addBulk(jobs)
    console.log(`[backfill] Queued ${n}–${batchEnd}`)
  }

  console.log('[backfill] Done. Monitor queue progress via BullMQ dashboard or blockQueue.getJobCounts().')
  process.exit(0)
}

backfill().catch(err => {
  console.error('[backfill] Fatal error:', err)
  process.exit(1)
})
