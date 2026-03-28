/**
 * Chain-aware RPC provider singleton.
 * Uses globalThis so the provider survives Next.js hot-module reloads
 * and is shared across all server-side renders in the same process.
 * Resets on connection error so the next call gets a fresh provider.
 */
import { JsonRpcProvider } from 'ethers'
import { chainConfig } from './chain'

const g = globalThis as typeof globalThis & {
  __explorer_provider?: JsonRpcProvider | null
}

export function getProvider(): JsonRpcProvider {
  if (!g.__explorer_provider) {
    const url = process.env[chainConfig.rpcEnvVar] ?? chainConfig.defaultRpcUrl
    const provider = new JsonRpcProvider(url)
    provider.on('error', () => { g.__explorer_provider = null })
    g.__explorer_provider = provider
  }
  return g.__explorer_provider
}
