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

/** Sentinel distinct from `null` (a valid "no override" answer from getSetting). */
const SETTINGS_STALLED = Symbol('settings-stalled')
/** Generous for a 60s-memoized loader; only a cold miss touches the DB at all. */
const SETTINGS_LOOKUP_TIMEOUT_MS = 500

/** Construct + register the singleton for a resolved config. */
function buildProvider({ url, timeoutMs }: { url: string; timeoutMs: number }): JsonRpcProvider {
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
  //
  // BOUNDED: callers used to race getProvider() (synchronous) against their own
  // timeouts. Awaiting an unbounded DB read here would put the config lookup
  // OUTSIDE those races, so a stalled settings query could hang a page that was
  // previously guaranteed to fail fast. Cap it, and on timeout prefer the
  // last-known-good provider before falling back to env/default.
  const override = await Promise.race([
    getSetting('rpc'),
    new Promise<typeof SETTINGS_STALLED>((resolve) =>
      setTimeout(() => resolve(SETTINGS_STALLED), SETTINGS_LOOKUP_TIMEOUT_MS),
    ),
  ])
  if (override === SETTINGS_STALLED) {
    const lastKnown = g.__explorer_provider
    if (lastKnown) return lastKnown.provider
    return buildProvider(resolveRpc(null, chainConfig, process.env))
  }

  const { url, timeoutMs } = resolveRpc(override, chainConfig, process.env)

  const current = g.__explorer_provider
  if (current && current.url === url && current.timeoutMs === timeoutMs) return current.provider

  return buildProvider({ url, timeoutMs })
}
