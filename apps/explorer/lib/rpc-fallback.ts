/**
 * RPC fallback utilities for BNBScan.
 * Used when a tx hash or block number is not in the local DB — fetches live from chain.
 *
 * Negative cache: null results are cached for NULL_TTL_MS to prevent repeated
 * RPC calls for the same missing entity within a short window.
 */
import { getWebProvider } from './rpc'
import { registerCache } from './cache-registry'

// Shapes that satisfy what the tx and block detail pages render
export type RpcTx = {
  hash: string
  blockNumber: number
  fromAddress: string
  toAddress: string | null
  value: string
  gas: bigint
  gasPrice: string
  gasUsed: bigint
  input: string
  status: boolean
  methodId: string | null
  txIndex: number
  nonce: number
  txType: number
  timestamp: Date
  _fromRpc: true   // sentinel so the page can show a subtle note
}

export type RpcBlock = {
  number: number
  hash: string
  parentHash: string
  timestamp: Date
  miner: string
  gasUsed: bigint
  gasLimit: bigint
  baseFeePerGas: string | null
  txCount: number
  size: number
  txHashes: string[]  // hashes only — txs may not be in DB yet
  /**
   * Full transaction bodies from the SAME eth_getBlockByNumber call. The call
   * used to pass prefetch=false and keep only the hashes, so a block outside
   * our retention window rendered as a bare list of hashes with no From, To,
   * Value or Method — data the node had already been asked for.
   *
   * `status` is absent by design: it lives in the receipts, not the block, and
   * inventing "Success" for every row would be a lie. The page omits the column
   * on this path instead.
   */
  txs: RpcBlockTx[]
  _fromRpc: true
}

export type RpcBlockTx = {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  gas: bigint
  gasPrice: string
  methodId: string | null
  txIndex: number
  timestamp: Date
}

// Negative cache — prevents hammering RPC for entities that don't exist
const NULL_TTL_MS = 2 * 60 * 1000  // 2 minutes (reduced from 5)
const NULL_CACHE_MAX = 5_000       // reduced from 10K to limit memory
const nullCache = new Map<string, number>()  // key → expiry timestamp

// Background cleanup — evict expired entries every 30s
const _rpcNullCleanup = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of nullCache) {
    if (now > v) nullCache.delete(k)
  }
}, 30_000)
if (_rpcNullCleanup.unref) _rpcNullCleanup.unref()
registerCache('rpc-null', () => nullCache.size)

function isNullCached(key: string): boolean {
  const expiry = nullCache.get(key)
  if (!expiry) return false
  if (Date.now() > expiry) { nullCache.delete(key); return false }
  return true
}

function setNullCache(key: string): void {
  if (nullCache.size >= NULL_CACHE_MAX) {
    // Evict the oldest entry
    nullCache.delete(nullCache.keys().next().value!)
  }
  nullCache.set(key, Date.now() + NULL_TTL_MS)
}

export async function fetchTxFromRpc(hash: string): Promise<RpcTx | null> {
  const cacheKey = `tx:${hash.toLowerCase()}`
  if (isNullCached(cacheKey)) return null

  try {
    const provider = await getWebProvider()
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ])
    if (!tx) { setNullCache(cacheKey); return null }

    const blockTs = tx.blockNumber
      ? await provider.getBlock(tx.blockNumber).then(b => b ? new Date(b.timestamp * 1000) : new Date())
      : new Date()

    return {
      hash: tx.hash,
      blockNumber: tx.blockNumber ?? 0,
      fromAddress: tx.from.toLowerCase(),
      toAddress: tx.to?.toLowerCase() ?? null,
      value: tx.value.toString(),
      gas: tx.gasLimit,
      gasPrice: (tx.gasPrice ?? tx.maxFeePerGas ?? 0n).toString(),
      gasUsed: receipt?.gasUsed ?? 0n,
      input: tx.data,
      status: receipt ? receipt.status === 1 : true,
      methodId: tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
      txIndex: tx.index ?? 0,
      nonce: tx.nonce,
      txType: tx.type ?? 0,
      timestamp: blockTs,
      _fromRpc: true,
    }
  } catch {
    return null
  }
}

export async function fetchBlockFromRpc(blockNumber: number): Promise<RpcBlock | null> {
  const cacheKey = `block:${blockNumber}`
  if (isNullCached(cacheKey)) return null

  try {
    const provider = await getWebProvider()
    // prefetch=true: same RPC round trip, but the transaction bodies come back.
    const block = await provider.getBlock(blockNumber, true)
    if (!block) { setNullCache(cacheKey); return null }
    return {
      number: block.number,
      hash: block.hash ?? '',
      parentHash: block.parentHash,
      timestamp: new Date(block.timestamp * 1000),
      miner: block.miner.toLowerCase(),
      gasUsed: block.gasUsed,
      gasLimit: block.gasLimit,
      baseFeePerGas: block.baseFeePerGas?.toString() ?? null,
      txCount: block.transactions.length,
      size: 0,
      txHashes: block.transactions as string[],
      txs: block.prefetchedTransactions.map((t) => ({
        hash: t.hash,
        fromAddress: t.from.toLowerCase(),
        toAddress: t.to?.toLowerCase() ?? null,
        value: t.value.toString(),
        gas: t.gasLimit,
        gasPrice: (t.gasPrice ?? t.maxFeePerGas ?? 0n).toString(),
        methodId: t.data.length >= 10 ? t.data.slice(0, 10) : null,
        txIndex: t.index ?? 0,
        timestamp: new Date(block.timestamp * 1000),
      })),
      _fromRpc: true,
    }
  } catch {
    return null
  }
}
