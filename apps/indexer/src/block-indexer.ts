import { JsonRpcProvider } from 'ethers'
import { blockQueue } from './queue'
import { getDb, schema } from '@bnbscan/db'
import { desc } from 'drizzle-orm'

const POLL_INTERVAL_MS = 3000
const RPC_URL = process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/'

export async function startBlockIndexer() {
  const provider = new JsonRpcProvider(RPC_URL)
  const db = getDb()
  console.log('[block-indexer] Starting polling loop...')

  let lastIndexed = await getLastIndexedBlock(db)
  console.log(`[block-indexer] Resuming from block ${lastIndexed}`)

  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber()

      if (latestBlock > lastIndexed) {
        for (let n = lastIndexed + 1; n <= latestBlock; n++) {
          await blockQueue.add('process-block', { blockNumber: n }, {
            jobId: `block-${n}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          })
        }
        console.log(`[block-indexer] Queued blocks ${lastIndexed + 1}–${latestBlock}`)
        lastIndexed = latestBlock
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
