import { JsonRpcProvider, Network } from 'ethers'
import { getChainConfig } from '@bnbscan/chain-config'

/**
 * Shared RPC provider singleton for the indexer.
 * Uses chain config to determine the correct RPC URL.
 *
 * `staticNetwork` pins the chain ID so ethers doesn't re-run eth_chainId
 * auto-detection before every request. See index.ts for the full rationale.
 */
const chain = getChainConfig()
const network = Network.from(chain.chainId)
const provider = new JsonRpcProvider(
  process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl,
  network,
  { staticNetwork: network }
)

export function getProvider(): JsonRpcProvider {
  return provider
}
