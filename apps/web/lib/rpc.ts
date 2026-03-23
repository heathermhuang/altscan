/**
 * BNB Chain RPC provider for apps/web.
 * Uses globalThis singleton so the provider survives Next.js hot-module reloads
 * and is shared across all server-side renders in the same process.
 * Resets on connection error so the next call gets a fresh provider.
 */
import { JsonRpcProvider } from 'ethers'

const g = globalThis as typeof globalThis & {
  __bnbscan_provider?: JsonRpcProvider | null
}

export function getProvider(): JsonRpcProvider {
  if (!g.__bnbscan_provider) {
    const url = process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/'
    const provider = new JsonRpcProvider(url)
    // Null-clear on network error — next call creates a fresh connection
    provider.on('error', () => { g.__bnbscan_provider = null })
    g.__bnbscan_provider = provider
  }
  return g.__bnbscan_provider
}
