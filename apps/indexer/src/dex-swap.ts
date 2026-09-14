/**
 * Uniswap-V2-style Swap events: PancakeSwap V2 on BNB, Uniswap V2 on Ethereum,
 * and every fork that kept the event.
 *
 * Pure — no DB, no RPC — so it can be tested against real logs without the
 * block processor (whose tests reach a real database).
 */
import { AbiCoder, id as keccak256id } from 'ethers'

export const SWAP_V2_TOPIC = keccak256id('Swap(address,uint256,uint256,uint256,uint256,address)')

const abi = AbiCoder.defaultAbiCoder()

export type V2Swap = {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  maker: string
}

/**
 * Decode one Swap log against its pair's [token0, token1]. Returns null when the
 * log does not have the V2 shape; throws on data that will not decode.
 */
export function decodeV2Swap(
  log: { topics: readonly string[]; data: string },
  pairTokens: readonly [string, string],
): V2Swap | null {
  // sender and to are indexed, so data is the four uint256 amounts: 4 x 32 bytes
  // = 128 bytes = 256 hex chars, plus "0x". From 3a1c74c (2026-03-20) this read
  // 514 — 256 bytes counted where there are 128 — which rejected every real swap
  // and left dex_trades empty on both chains.
  const isV2 = log.topics.length === 3 && log.data.length >= 2 + 4 * 64
  if (!isV2) return null

  const [token0, token1] = pairTokens
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

  return {
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    maker: ('0x' + log.topics[2].slice(26)).toLowerCase(),
  }
}
