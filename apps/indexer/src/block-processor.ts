import { JsonRpcProvider } from 'ethers'
import { getDb, schema } from '@bnbscan/db'
import { processLogs, type NormalizedReceipt } from './log-processor'
import { notifyWebhooks } from './webhook-notifier'

export async function processBlock(blockNumber: number, provider: JsonRpcProvider, skipLogs = false) {
  const db = getDb()
  const block = await provider.getBlock(blockNumber, true)  // true = include txs
  if (!block) throw new Error(`Block ${blockNumber} not found`)
  if (!block.hash) throw new Error(`Block ${blockNumber} has no hash (pending block?)`)

  const timestamp = new Date(Number(block.timestamp) * 1000)

  // Insert block
  await db.insert(schema.blocks).values({
    number: block.number,
    hash: block.hash,
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
    value: tx.value.toString(),
    gas: tx.gasLimit.toString(),
    gasPrice: tx.gasPrice?.toString() ?? '0',
    gasUsed: 0n,
    // Truncate calldata to 500 chars — saves ~95% of input storage.
    // Method ID (first 10 chars) + ~245 bytes is enough for ERC-20/swap decoding.
    // Full calldata is rarely needed on a block explorer.
    input: tx.data.length > 500 ? tx.data.slice(0, 500) : tx.data,
    status: true,
    methodId: tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
    txIndex: idx,
    nonce: tx.nonce,
    txType: tx.type ?? 0,
    timestamp,
  }))

  if (txValues.length > 0) {
    await db.insert(schema.transactions).values(txValues).onConflictDoNothing()
  }

  // Process logs inline (no queue) — fetch all receipts in ONE RPC call
  // Skip entirely if batch receipts are disabled to avoid N+1 RPC explosion
  if (!skipLogs && block.prefetchedTransactions.length > 0 && blockReceiptsSupported) {
    const receiptMap = await fetchBlockReceipts(provider, blockNumber)
    for (const tx of block.prefetchedTransactions) {
      try {
        await processLogs(tx.hash, blockNumber, timestamp, provider, receiptMap.get(tx.hash.toLowerCase()))
      } catch (err) {
        console.warn(`[block-processor] Log processing failed for ${tx.hash}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  console.log(`[block-processor] Block ${block.number} — ${block.prefetchedTransactions.length} txs`)

  // Deliver webhooks (non-blocking)
  if (!skipLogs && txValues.length > 0) {
    notifyWebhooks(
      txValues.map(tx => ({ hash: tx.hash, fromAddress: tx.fromAddress, toAddress: tx.toAddress ?? null, value: tx.value })),
      block.number,
      timestamp,
    ).catch(err => console.error('[webhook-notifier] delivery error:', err))
  }
}

let blockReceiptsSupported = true
let blockReceiptsWarnCount = 0

/** Fetch all receipts for a block in one RPC call. Falls back to empty map if unsupported. */
async function fetchBlockReceipts(
  provider: JsonRpcProvider,
  blockNumber: number,
): Promise<Map<string, NormalizedReceipt>> {
  const map = new Map<string, NormalizedReceipt>()
  if (!blockReceiptsSupported) return map
  try {
    const blockHex = '0x' + blockNumber.toString(16)
    const raw = await provider.send('eth_getBlockReceipts', [blockHex]) as Array<{
      transactionHash: string
      status: string
      gasUsed: string
      logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>
    }> | null

    for (const r of raw ?? []) {
      map.set(r.transactionHash.toLowerCase(), {
        status: r.status === '0x1',
        gasUsed: BigInt(r.gasUsed),
        logs: r.logs.map(l => ({
          address: l.address.toLowerCase(),
          topics: l.topics,
          data: l.data,
          index: parseInt(l.logIndex, 16),
        })),
      })
    }
  } catch (err) {
    blockReceiptsWarnCount++
    if (blockReceiptsWarnCount <= 3) {
      console.warn(`[block-processor] eth_getBlockReceipts failed for block ${blockNumber} (${blockReceiptsWarnCount}/3):`, err instanceof Error ? err.message : err)
    }
    if (blockReceiptsWarnCount >= 3) {
      console.warn('[block-processor] eth_getBlockReceipts failed 3x — disabling batch receipts. Per-tx fallback active (HIGH RPC COST).')
      blockReceiptsSupported = false
    }
  }
  return map
}
