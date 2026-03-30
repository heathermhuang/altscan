import { JsonRpcProvider } from 'ethers'
import { getDb, schema } from '@bnbscan/db'
import { sql } from 'drizzle-orm'
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

  // Insert transactions — use RETURNING to get newly-inserted rows for address tracking
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
    const inserted = await db.insert(schema.transactions)
      .values(txValues)
      .onConflictDoNothing()
      .returning({
        fromAddress: schema.transactions.fromAddress,
        toAddress: schema.transactions.toAddress,
      })

    // Batch-upsert addresses for newly-inserted transactions only.
    // Using unnest avoids N queries — one SQL call regardless of address count.
    if (inserted.length > 0) {
      await upsertAddresses(inserted, timestamp)
    }
  }

  // Process logs inline (no queue) — fetch all receipts in ONE RPC call
  if (!skipLogs && block.prefetchedTransactions.length > 0) {
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

/**
 * Batch-upsert address rows after block processing.
 * Counts per-address appearances in newly-inserted transactions so replays
 * don't double-count (we only pass RETURNING rows, which are truly new).
 * Uses unnest to send a single SQL statement regardless of address count.
 */
async function upsertAddresses(
  txs: Array<{ fromAddress: string; toAddress: string | null }>,
  timestamp: Date,
): Promise<void> {
  const db = getDb()
  const counts = new Map<string, number>()
  for (const tx of txs) {
    counts.set(tx.fromAddress, (counts.get(tx.fromAddress) ?? 0) + 1)
    if (tx.toAddress) counts.set(tx.toAddress, (counts.get(tx.toAddress) ?? 0) + 1)
  }
  if (counts.size === 0) return

  const addrs = Array.from(counts.keys())
  const cnts  = Array.from(counts.values())
  const ts    = timestamp.toISOString()

  await db.execute(sql`
    INSERT INTO addresses (address, balance, tx_count, is_contract, first_seen, last_seen)
    SELECT
      unnest(${addrs}::text[])      AS address,
      '0'::numeric                  AS balance,
      unnest(${cnts}::int[])        AS tx_count,
      false                         AS is_contract,
      ${ts}::timestamptz            AS first_seen,
      ${ts}::timestamptz            AS last_seen
    ON CONFLICT (address) DO UPDATE SET
      tx_count  = addresses.tx_count + EXCLUDED.tx_count,
      last_seen = GREATEST(addresses.last_seen, EXCLUDED.last_seen)
  `)
}

/** Fetch all receipts for a block in one RPC call. Falls back to empty map if unsupported. */
async function fetchBlockReceipts(
  provider: JsonRpcProvider,
  blockNumber: number,
): Promise<Map<string, NormalizedReceipt>> {
  const map = new Map<string, NormalizedReceipt>()
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
  } catch {
    // eth_getBlockReceipts not supported — processLogs will fall back to per-tx fetching
  }
  return map
}
