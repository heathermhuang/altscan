/**
 * Uniswap V2 / V3 swap decoder for Ethereum.
 *
 * V2 Swap event signature (same as PancakeSwap V2):
 *   Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
 *
 * V3 Swap event signature:
 *   Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
 */
import { Log, AbiCoder, Contract, JsonRpcProvider } from 'ethers'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

const provider = new JsonRpcProvider(process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com')
const abi = AbiCoder.defaultAbiCoder()

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]

// Cache pair → [token0, token1] — capped at 10k
const pairCache = new Map<string, [string, string]>()
const PAIR_CACHE_MAX = 10_000

async function getPairTokens(pairAddress: string): Promise<[string, string] | null> {
  if (pairCache.has(pairAddress)) return pairCache.get(pairAddress)!
  try {
    const pair = new Contract(pairAddress, PAIR_ABI, provider)
    const [t0, t1] = await Promise.all([pair.token0(), pair.token1()])
    const tokens: [string, string] = [t0.toLowerCase(), t1.toLowerCase()]
    if (pairCache.size >= PAIR_CACHE_MAX) {
      pairCache.delete(pairCache.keys().next().value!)
    }
    pairCache.set(pairAddress, tokens)
    return tokens
  } catch {
    return null
  }
}

export async function decodeDexTrade(
  db: ReturnType<typeof drizzle>,
  log: Log,
  txHash: string,
  blockNumber: number,
  timestamp: Date
) {
  try {
    const pairAddress = log.address.toLowerCase()

    // V2: topics=[sig, sender, to] data=4 x uint256
    const isV2 = log.topics.length === 3 && log.data.length >= 514
    // V3: topics=[sig, sender, recipient] data includes int256, int256, uint160, uint128, int24
    const isV3 = log.topics.length === 3 && log.data.length >= 322 && !isV2

    if (!isV2 && !isV3) return

    const tokens = await getPairTokens(pairAddress)
    if (!tokens) return
    const [token0, token1] = tokens

    let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint, dex: string

    if (isV2) {
      const [a0In, a1In, a0Out, a1Out] = abi.decode(
        ['uint256', 'uint256', 'uint256', 'uint256'], log.data
      ) as bigint[]

      if (a0In > 0n) {
        tokenIn = token0; tokenOut = token1
        amountIn = a0In; amountOut = a1Out
      } else {
        tokenIn = token1; tokenOut = token0
        amountIn = a1In; amountOut = a0Out
      }
      dex = 'Uniswap V2'
    } else {
      // V3: amount0 and amount1 are signed — positive = flowing in, negative = flowing out
      const [amount0, amount1] = abi.decode(['int256', 'int256'], log.data.slice(0, 130)) as bigint[]
      if (amount0 > 0n) {
        tokenIn = token0; tokenOut = token1
        amountIn = amount0; amountOut = -amount1
      } else {
        tokenIn = token1; tokenOut = token0
        amountIn = amount1; amountOut = -amount0
      }
      dex = 'Uniswap V3'
    }

    const maker = ('0x' + log.topics[2].slice(26)).toLowerCase()

    await db.execute(sql`
      INSERT INTO dex_trades (tx_hash, dex, pair_address, token_in, token_out, amount_in, amount_out, maker, block_number, timestamp)
      VALUES (
        ${txHash}, ${dex}, ${pairAddress},
        ${tokenIn}, ${tokenOut},
        ${amountIn.toString()}, ${amountOut.toString()},
        ${maker},
        ${blockNumber},
        ${timestamp.toISOString()}
      )
      ON CONFLICT DO NOTHING
    `)
  } catch {
    // Skip malformed swap events
  }
}
