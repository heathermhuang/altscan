/**
 * Chain-aware RPC provider singleton.
 * Uses globalThis so the provider survives Next.js hot-module reloads
 * and is shared across all server-side renders in the same process.
 * Resets on connection error so the next call gets a fresh provider.
 */
import { JsonRpcProvider, FetchRequest } from 'ethers'
import { chainConfig } from './chain'

const g = globalThis as typeof globalThis & {
  __explorer_provider?: JsonRpcProvider | null
}

// ethers' FetchRequest defaults to a 300s (5 min) timeout. On a slow or
// rate-limited public RPC that meant page-blocking server calls (e.g. the token
// page's metadata lookup) could hang for minutes and surface as "Connection
// closed". Fail fast instead so callers' .catch() fallbacks kick in quickly.
const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS ?? '8000', 10) || 8000

export function getProvider(): JsonRpcProvider {
  if (!g.__explorer_provider) {
    const url = process.env[chainConfig.rpcEnvVar] ?? chainConfig.defaultRpcUrl
    const req = new FetchRequest(url)
    req.timeout = RPC_TIMEOUT_MS
    const provider = new JsonRpcProvider(req)
    provider.on('error', () => { g.__explorer_provider = null })
    g.__explorer_provider = provider
  }
  return g.__explorer_provider
}
