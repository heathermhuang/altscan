import { JsonRpcProvider } from 'ethers'

/**
 * Shared RPC provider singleton for the BNB indexer.
 * All modules use this instead of creating their own connections.
 */
const provider = new JsonRpcProvider(
  process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/'
)

export function getProvider(): JsonRpcProvider {
  return provider
}
