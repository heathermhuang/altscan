/**
 * Uniswap-V2-style Swap events: PancakeSwap V2 on BNB, Uniswap V2 on Ethereum,
 * and every fork that kept the event.
 *
 * Pure — no DB, no RPC — so it can be tested against real logs without the
 * block processor (whose tests reach a real database).
 */
import { AbiCoder, id as keccak256id } from 'ethers'
import type { ChainKey } from '@altscan/chain-config'

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

/**
 * The factories whose pairs' swaps are recorded, and the label each is stored under. Any contract can emit
 * a V2-shaped Swap and answer token0()/token1(), so recording every such log stored trades of anyone's
 * making, at prices of their choosing, under the chain's main DEX's name. Addresses read from each chain on
 * 2026-10-24: factory() of the pairs in dex-swap.test.ts, and getPair() back to them.
 */
export const V2_FACTORIES: Record<ChainKey, readonly { address: string; dex: string }[]> = {
  bnb: [{ address: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', dex: 'PancakeSwap V2' }],
  eth: [
    { address: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', dex: 'Uniswap V2' },
    { address: '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac', dex: 'SushiSwap' },
  ],
}

export type V2Pair = { tokens: [string, string]; dex: string }

export type V2PairReader = {
  /** The pair contract's token0(), token1() and factory(); null when it answered that it has none of them. */
  pairInfo(pair: string): Promise<{ token0: string; token1: string; factory: string } | null>
  /** factory.getPair(tokenA, tokenB). */
  getPair(factory: string, tokenA: string, tokenB: string): Promise<string>
}

/**
 * The pair behind a Swap log, when it is one of a listed factory's. A contract can claim a listed factory
 * from its own factory(); only the factory's registry, getPair(token0, token1), says the pair is its own.
 *
 * Null is a decision (not a listed factory's pair) and safe to remember. A throw is a read that failed
 * and says nothing about the pair.
 */
export async function resolveV2Pair(
  pair: string,
  factories: readonly { address: string; dex: string }[],
  reader: V2PairReader,
): Promise<V2Pair | null> {
  const address = pair.toLowerCase()
  const info = await reader.pairInfo(address)
  if (!info) return null
  const factory = factories.find((f) => f.address.toLowerCase() === info.factory.toLowerCase())
  if (!factory) return null
  const token0 = info.token0.toLowerCase()
  const token1 = info.token1.toLowerCase()
  if ((await reader.getPair(factory.address, token0, token1)).toLowerCase() !== address) return null
  return { tokens: [token0, token1], dex: factory.dex }
}
