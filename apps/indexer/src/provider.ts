import { JsonRpcProvider, Network } from 'ethers'
import { getChainConfig } from '@altscan/chain-config'
import { formatRedactedError } from './rpc-failover'
import { indexerConfig } from './config-instance'

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

/**
 * The canonical parsed endpoint list. Exported so every module that logs an
 * RPC-derived error scrubs against the SAME set — index.ts used to parse its own
 * copy, which meant a sink could redact against a different list than the client
 * that produced the error. (codex P1 round 4.)
 */
export const RPC_URLS = (process.env[chain.rpcEnvVar] ?? chain.defaultRpcUrl)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

/**
 * Trace endpoint(s) for internal transactions — a SEPARATE list, because none of
 * the block endpoints can trace (bsc-dataseed returns "not available", publicnode
 * "does not exist"). Comma-separated like the block list; only the first is used.
 * Empty when unset: internal transactions then stay off whatever the flag says.
 */
export const TRACE_RPC_URLS = (process.env.TRACE_RPC_URL ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const rpcUrl = RPC_URLS[0] ?? chain.defaultRpcUrl
const network = Network.from(chain.chainId)
const provider = new JsonRpcProvider(rpcUrl, network, {
  staticNetwork: network,
  batchMaxCount: indexerConfig.rpc.batchMaxCount,
})

export function getProvider(): JsonRpcProvider {
  return provider
}

/**
 * Format any RPC-derived error for logging with endpoint credentials stripped.
 *
 * Single definition, shared by every module with its own catch-and-log. Modules
 * that swallow their RPC errors internally (validator-syncer) are NOT covered by
 * the caller's wrappers, so they must call this themselves.
 */
export function safeRpcError(err: unknown): string {
  // The trace URL carries its key the same way, so it scrubs against the same set.
  return formatRedactedError(err, [...RPC_URLS, ...TRACE_RPC_URLS])
}
