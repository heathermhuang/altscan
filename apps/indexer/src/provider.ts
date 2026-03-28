import { JsonRpcProvider } from 'ethers'
import { getChainConfig } from '@bnbscan/chain-config'

/**
 * Shared RPC provider singleton for the indexer.
 * Uses chain config to determine the correct RPC URL.
 */
const chain = getChainConfig()
const provider = new JsonRpcProvider(
  process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl
)

export function getProvider(): JsonRpcProvider {
  return provider
}
