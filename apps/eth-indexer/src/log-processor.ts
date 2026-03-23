/**
 * Process transaction receipts: update tx status/gasUsed, insert raw logs,
 * decode token transfers and DEX trades.
 */
import { JsonRpcProvider, id as keccak256id } from 'ethers'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { decodeTokenTransfer } from './token-decoder'
import { decodeDexTrade } from './dex-decoder'

const provider = new JsonRpcProvider(process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com')

// ERC event topic0 signatures
const TRANSFER_TOPIC = keccak256id('Transfer(address,address,uint256)')
const TRANSFER_SINGLE_TOPIC = keccak256id('TransferSingle(address,address,address,uint256,uint256)')
// Same V2 swap event used by Uniswap V2 (and forks like SushiSwap)
const SWAP_V2_TOPIC = keccak256id('Swap(address,uint256,uint256,uint256,uint256,address)')
// Uniswap V3 swap event
const SWAP_V3_TOPIC = keccak256id('Swap(address,address,int256,int256,uint160,uint128,int24)')

export async function processLogs(
  db: ReturnType<typeof drizzle>,
  txHash: string,
  blockNumber: number,
  timestamp: Date
) {
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) return

  // Update tx row: status + gasUsed from receipt
  await db.execute(sql`
    UPDATE transactions
    SET status = ${receipt.status === 1}, gas_used = ${receipt.gasUsed.toString()}
    WHERE hash = ${txHash}
  `)

  // Bulk-insert raw logs for archival
  for (const log of receipt.logs) {
    try {
      await db.execute(sql`
        INSERT INTO logs (tx_hash, log_index, address, topic0, topic1, topic2, topic3, data, block_number)
        VALUES (
          ${txHash},
          ${log.index},
          ${log.address.toLowerCase()},
          ${log.topics[0] ?? null},
          ${log.topics[1] ?? null},
          ${log.topics[2] ?? null},
          ${log.topics[3] ?? null},
          ${log.data},
          ${blockNumber}
        )
        ON CONFLICT DO NOTHING
      `)
    } catch { /* skip duplicate logs */ }
  }

  // Decode semantic events
  for (const log of receipt.logs) {
    const topic0 = log.topics[0]
    if (!topic0) continue

    if (topic0 === TRANSFER_TOPIC && log.topics.length === 3) {
      // ERC-20 Transfer
      await decodeTokenTransfer(db, log, 'BEP20', blockNumber, timestamp, txHash)
    } else if (topic0 === TRANSFER_TOPIC && log.topics.length === 4) {
      // ERC-721 Transfer (tokenId in topics[3])
      await decodeTokenTransfer(db, log, 'BEP721', blockNumber, timestamp, txHash)
    } else if (topic0 === TRANSFER_SINGLE_TOPIC) {
      // ERC-1155 TransferSingle
      await decodeTokenTransfer(db, log, 'BEP1155', blockNumber, timestamp, txHash)
    } else if (topic0 === SWAP_V2_TOPIC || topic0 === SWAP_V3_TOPIC) {
      // Uniswap V2 or V3 swap
      await decodeDexTrade(db, log, txHash, blockNumber, timestamp)
    }
  }
}
