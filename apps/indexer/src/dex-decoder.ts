import { Log, AbiCoder, Contract } from 'ethers'
import { getDb, schema } from './db'
import { getProvider } from './provider'

const provider = getProvider()
const abi = AbiCoder.defaultAbiCoder()

// Cache pair → [token0, token1] to avoid repeated RPC calls
// Capped at 10k entries — BSC has ~50k active pairs, 10k covers the hot ones
const pairCache = new Map<string, [string, string]>()
const PAIR_CACHE_MAX = 10_000

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]

async function getPairTokens(pairAddress: string): Promise<[string, string] | null> {
  if (pairCache.has(pairAddress)) return pairCache.get(pairAddress)!
  try {
    const pair = new Contract(pairAddress, PAIR_ABI, provider)
    const [t0, t1] = await Promise.all([pair.token0(), pair.token1()])
    const tokens: [string, string] = [t0.toLowerCase(), t1.toLowerCase()]
    if (pairCache.size >= PAIR_CACHE_MAX) {
      // Evict oldest entry (Maps preserve insertion order)
      pairCache.delete(pairCache.keys().next().value!)
    }
    pairCache.set(pairAddress, tokens)
    return tokens
  } catch {
    return null
  }
}

export async function decodeDexTrade(
  log: Log,
  txHash: string,
  blockNumber: number,
  timestamp: Date
) {
  const db = getDb()

  try {
    const pairAddress = log.address.toLowerCase()

    // V2 Swap: topics[0]=event sig, topics[1]=sender, topics[2]=to — data has 4 x uint256
    // V2 Swap encodes 4 x uint256 = 256 bytes = 514 hex chars with 0x prefix
    const isV2 = log.topics.length === 3 && log.data.length >= 514
    if (!isV2) return

    const tokens = await getPairTokens(pairAddress)
    if (!tokens) return

    const [token0, token1] = tokens
    const [a0In, a1In, a0Out, a1Out] = abi.decode(
      ['uint256', 'uint256', 'uint256', 'uint256'], log.data
    ) as bigint[]

    let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint

    if (a0In > 0n) {
      tokenIn = token0; tokenOut = token1
      amountIn = a0In; amountOut = a1Out
    } else {
      tokenIn = token1; tokenOut = token0
      amountIn = a1In; amountOut = a0Out
    }

    const maker = ('0x' + log.topics[2].slice(26)).toLowerCase()

    await db.insert(schema.dexTrades).values({
      txHash,
      dex: 'PancakeSwap V2',
      pairAddress,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      maker,
      blockNumber,
      timestamp,
    }).onConflictDoNothing()
  } catch (err) {
    console.warn('[dex-decoder] Error decoding swap:', txHash, err instanceof Error ? err.message : err)
  }
}
