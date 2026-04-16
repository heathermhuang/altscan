import { JsonRpcProvider, Network } from 'ethers'
import { getChainConfig } from '@bnbscan/chain-config'

/**
 * Shared RPC provider singleton for one-off callers (validator-syncer etc.).
 * Uses chain config to determine the correct RPC URL.
 *
 * `BNB_RPC_URL` / `ETH_RPC_URL` may be a comma-separated list — index.ts
 * round-robins across them, but this singleton only needs one endpoint, so
 * we pick the first. Previously the raw env var was passed verbatim, so when
 * the multi-RPC config shipped every validator-syncer call fetched the
 * literal "url1,url2" string and got 403s.
 *
 * `staticNetwork` pins the chain ID so ethers doesn't re-run eth_chainId
 * auto-detection before every request. See index.ts for the full rationale.
 */
const chain = getChainConfig()
const rpcUrl = (process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)[0] ?? chain.defaultRpcUrl
const network = Network.from(chain.chainId)
const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network })

export function getProvider(): JsonRpcProvider {
  return provider
}
