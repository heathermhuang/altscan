/**
 * Ethereum RPC provider for apps/ethscan.
 * Uses globalThis singleton so the provider survives Next.js hot-module reloads
 * and is shared across all server-side renders in the same process.
 * Resets on connection error so the next call gets a fresh provider.
 */
import { JsonRpcProvider } from 'ethers'

const g = globalThis as typeof globalThis & {
  __ethscan_provider?: JsonRpcProvider | null
}

export function getProvider(): JsonRpcProvider {
  if (!g.__ethscan_provider) {
    const url = process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com'
    const provider = new JsonRpcProvider(url)
    // Null-clear on network error — next call creates a fresh connection
    provider.on('error', () => { g.__ethscan_provider = null })
    g.__ethscan_provider = provider
  }
  return g.__ethscan_provider
}
