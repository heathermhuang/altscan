import { JsonRpcProvider, id as keccak256id } from 'ethers'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '@bnbscan/db'
import { decodeTokenTransfer } from './token-decoder'
import { decodeDexTrade } from './dex-decoder'

const provider = new JsonRpcProvider(process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/')

// Well-known topic0 signatures
const TRANSFER_TOPIC = keccak256id('Transfer(address,address,uint256)')
const TRANSFER_SINGLE_TOPIC = keccak256id('TransferSingle(address,address,address,uint256,uint256)')
const SWAP_V2_TOPIC = keccak256id('Swap(address,uint256,uint256,uint256,uint256,address)')

export async function processLogs(txHash: string, blockNumber: number, timestamp: Date) {
  const db = getDb()
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) return

  // Update tx status + gasUsed
  await db.update(schema.transactions)
    .set({ status: receipt.status === 1, gasUsed: receipt.gasUsed.toString() })
    .where(eq(schema.transactions.hash, txHash))

  // Bulk insert raw logs
  const logValues = receipt.logs.map(log => ({
    txHash,
    logIndex: log.index,
    address: log.address.toLowerCase(),
    topic0: log.topics[0] ?? null,
    topic1: log.topics[1] ?? null,
    topic2: log.topics[2] ?? null,
    topic3: log.topics[3] ?? null,
    data: log.data,
    blockNumber,
  }))

  if (logValues.length > 0) {
    await db.insert(schema.logs).values(logValues).onConflictDoNothing()
  }

  // Decode token transfers + DEX trades
  for (const log of receipt.logs) {
    const topic0 = log.topics[0]
    if (topic0 === TRANSFER_TOPIC && log.topics.length === 3) {
      await decodeTokenTransfer(log, 'BEP20', blockNumber, timestamp, txHash)
    } else if (topic0 === TRANSFER_TOPIC && log.topics.length === 4) {
      await decodeTokenTransfer(log, 'BEP721', blockNumber, timestamp, txHash)
    } else if (topic0 === TRANSFER_SINGLE_TOPIC) {
      await decodeTokenTransfer(log, 'BEP1155', blockNumber, timestamp, txHash)
    } else if (topic0 === SWAP_V2_TOPIC) {
      await decodeDexTrade(log, txHash, blockNumber, timestamp)
    }
  }
}
