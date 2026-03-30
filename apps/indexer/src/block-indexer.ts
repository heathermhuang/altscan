import { getDb, schema } from './db'
import { desc } from 'drizzle-orm'
import { blockQueue } from './queue'
import { getProvider } from './provider'

const POLL_INTERVAL_MS = 3000
const MAX_QUEUE_BATCH = 500  // Cap blocks queued per cycle to prevent Redis flooding

export async function startBlockIndexer() {
  const provider = getProvider()
  const db = getDb()
  console.log('[block-indexer] Starting polling loop...')

  let lastIndexed = await getLastIndexedBlock(db)
  console.log(`[block-indexer] Resuming from block ${lastIndexed}`)

  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber()

      if (latestBlock > lastIndexed) {
        // Cap the batch size to avoid flooding Redis when far behind
        const gap = latestBlock - lastIndexed
        const target = Math.min(lastIndexed + MAX_QUEUE_BATCH, latestBlock)

        if (gap > MAX_QUEUE_BATCH) {
          console.log(`[block-indexer] ${gap} blocks behind — queueing ${MAX_QUEUE_BATCH} (${lastIndexed + 1}–${target})`)
        }

        for (let n = lastIndexed + 1; n <= target; n++) {
          await blockQueue.add('process-block', { blockNumber: n }, {
            jobId: `block-${n}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          })
        }
        if (gap <= MAX_QUEUE_BATCH) {
          console.log(`[block-indexer] Queued blocks ${lastIndexed + 1}–${target}`)
        }
        lastIndexed = target
      }
    } catch (err) {
      console.error('[block-indexer] Poll error:', err)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

async function getLastIndexedBlock(db: ReturnType<typeof getDb>): Promise<number> {
  const result = await db
    .select({ number: schema.blocks.number })
    .from(schema.blocks)
    .orderBy(desc(schema.blocks.number))
    .limit(1)
  return result[0]?.number ?? Number(process.env.START_BLOCK ?? '38000000')
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
