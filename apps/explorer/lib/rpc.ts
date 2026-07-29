/**
 * Chain-aware RPC provider singleton.
 *
 * The URL/timeout come from the `rpc` settings namespace (console override) and
 * fall back to env → chain default via resolveRpc. Because an operator can change
 * the URL at runtime, the singleton is KEYED on {url, timeoutMs}: a change
 * rebuilds the provider, an unchanged config reuses it. globalThis so it survives
 * Next.js hot-module reloads and is shared across server-side renders in the
 * same process. Resets on connection error so the next call gets a fresh provider.
 */
import { JsonRpcProvider, FetchRequest } from 'ethers'
import { chainConfig } from './chain'
import { getSetting } from './settings'
import { resolveRpc } from './settings-defaults'

type ProviderEntry = { url: string; timeoutMs: number; provider: JsonRpcProvider }

const g = globalThis as typeof globalThis & {
  __explorer_provider?: ProviderEntry | null
}

/**
 * Build (or reuse) the provider for the currently-resolved RPC config.
 *
 * ethers' FetchRequest defaults to a 300s (5 min) timeout. On a slow or
 * rate-limited public RPC that meant page-blocking server calls (e.g. the token
 * page's metadata lookup) could hang for minutes and surface as "Connection
 * closed". Fail fast instead so callers' .catch() fallbacks kick in quickly.
 */
export async function getWebProvider(): Promise<JsonRpcProvider> {
  // 60s cached loader, tagged 'settings' → an admin PUT applies near-instantly
  // via revalidateTag. Returns null on ANY failure, so a DB blip resolves to
  // env/default rather than breaking every render that needs an RPC.
  const override = await getSetting('rpc')
  const { url, timeoutMs } = resolveRpc(override, chainConfig, process.env)

  const current = g.__explorer_provider
  if (current && current.url === url && current.timeoutMs === timeoutMs) return current.provider

  const req = new FetchRequest(url)
  req.timeout = timeoutMs
  const provider = new JsonRpcProvider(req)
  // Identity guard: a stale provider's late error must not wipe a provider that
  // has since been rebuilt for a new URL.
  provider.on('error', () => {
    if (g.__explorer_provider?.provider === provider) g.__explorer_provider = null
  })
  g.__explorer_provider = { url, timeoutMs, provider }
  return provider
}
