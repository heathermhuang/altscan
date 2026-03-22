import { JsonRpcProvider } from 'ethers'
import { getDb, schema } from '@bnbscan/db'
import { logQueue } from './queue'

const provider = new JsonRpcProvider(process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/')

export async function processBlock(blockNumber: number, skipLogs = false) {
  const db = getDb()
  const block = await provider.getBlock(blockNumber, true)  // true = include txs
  if (!block) throw new Error(`Block ${blockNumber} not found`)

  const timestamp = new Date(Number(block.timestamp) * 1000)

  // Insert block
  await db.insert(schema.blocks).values({
    number: block.number,
    hash: block.hash!,
    parentHash: block.parentHash,
    timestamp,
    miner: block.miner.toLowerCase(),
    gasUsed: block.gasUsed.toString(),
    gasLimit: block.gasLimit.toString(),
    baseFeePerGas: block.baseFeePerGas?.toString() ?? null,
    txCount: block.transactions.length,
    size: 0,
  }).onConflictDoNothing()

  // Insert transactions
  const txValues = block.prefetchedTransactions.map((tx, idx) => ({
    hash: tx.hash,
    blockNumber: block.number,
    fromAddress: tx.from.toLowerCase(),
    toAddress: tx.to?.toLowerCase() ?? null,
    value: tx.value.toString(),  // raw wei string
    gas: tx.gasLimit.toString(),
    gasPrice: tx.gasPrice?.toString() ?? '0',
    gasUsed: 0n,   // updated from receipt by log-processor
    input: tx.data,
    status: true,  // updated from receipt by log-processor
    methodId: tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
    txIndex: idx,
    timestamp,
  }))

  if (txValues.length > 0) {
    await db.insert(schema.transactions).values(txValues).onConflictDoNothing()
  }

  // Queue log processing for each tx (skip for historical backfill to save RPC calls)
  if (!skipLogs) {
    for (const tx of block.prefetchedTransactions) {
      await logQueue.add('process-logs', {
        txHash: tx.hash,
        blockNumber: block.number,
        timestamp: timestamp.toISOString(),
      }, {
        jobId: `logs-${tx.hash}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      })
    }
  }

  console.log(`[block-processor] Block ${block.number} — ${block.prefetchedTransactions.length} txs`)
}
