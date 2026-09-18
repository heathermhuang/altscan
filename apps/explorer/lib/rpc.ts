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
import { AbstractProvider, JsonRpcProvider, FetchRequest, Network, type PerformActionRequest } from 'ethers'
import { chainConfig } from './chain'
import { getSetting } from './settings'
import { resolveRpc } from './settings-defaults'

/**
 * Tries each endpoint in order and returns the first answer; if every endpoint
 * fails, throws the first one's error. A null result is an answer, not a failure.
 *
 * ethers' own FallbackProvider cannot do this. At quorum 1 an error meets quorum
 * as readily as a result, so the first endpoint's 408 is thrown without the next
 * being asked, and when a stall does start the next one, its answer loses the tie
 * to the first endpoint's later error (rpc.failover.test.ts).
 */
class FailoverProvider extends AbstractProvider {
  readonly #network: Network
  readonly #endpoints: JsonRpcProvider[]

  constructor(endpoints: JsonRpcProvider[], network: Network) {
    super(network)
    this.#network = network
    this.#endpoints = endpoints
  }

  async _detectNetwork(): Promise<Network> {
    return this.#network
  }

  async _perform<T = unknown>(req: PerformActionRequest): Promise<T> {
    let firstError: unknown
    for (const endpoint of this.#endpoints) {
      try {
        return await endpoint._perform(req)
      } catch (error) {
        firstError ??= error
      }
    }
    throw firstError
  }
}

type ProviderEntry = { key: string; timeoutMs: number; provider: AbstractProvider }

const g = globalThis as typeof globalThis & {
  __explorer_provider?: ProviderEntry | null
}

/** Sentinel distinct from `null` (a valid "no override" answer from getSetting). */
const SETTINGS_STALLED = Symbol('settings-stalled')
/** Generous for a 60s-memoized loader; only a cold miss touches the DB at all. */
const SETTINGS_LOOKUP_TIMEOUT_MS = 500

/** Identity of a resolved config — the WHOLE list, so adding or reordering an
 *  endpoint rebuilds rather than being mistaken for the config already held. */
const providerKey = (urls: string[]) => urls.join(',')

/** Construct + register the singleton for a resolved config. */
function buildProvider({ urls, timeoutMs }: { urls: string[]; timeoutMs: number }): AbstractProvider {
  // staticNetwork pins the chain id. Without it ethers sends eth_chainId before
  // every call (concurrent calls share one), so a rate-limited public RPC sees
  // up to twice our real traffic.
  const network = Network.from(chainConfig.chainId)
  const endpoints = urls.map((url) => {
    const req = new FetchRequest(url)
    req.timeout = timeoutMs
    // batchMaxCount 1: every call goes out as its own request. ethers' default
    // (100) coalesces concurrent calls into one JSON-RPC batch, and because this
    // provider is a process-wide singleton, calls from concurrent page renders
    // batch TOGETHER — the batch grows with traffic. drpc's free plan rejects any
    // batch over 3 with a 500 for the whole batch, which failed chain-tip on
    // most ETH tx pages and, via the fallback's catch, rendered real txs as
    // "not found". Every endpoint accepts single requests.
    return new JsonRpcProvider(req, network, { staticNetwork: network, batchMaxCount: 1 })
  })

  // One endpoint stays a plain JsonRpcProvider — the shape both chains run in
  // production. Two or more are tried in order, one at a time.
  const provider: AbstractProvider = endpoints.length === 1
    ? endpoints[0]
    : new FailoverProvider(endpoints, network)

  // Identity guard: a stale provider's late error must not wipe a provider that
  // has since been rebuilt for a new URL.
  provider.on('error', () => {
    if (g.__explorer_provider?.provider === provider) g.__explorer_provider = null
  })
  g.__explorer_provider = { key: providerKey(urls), timeoutMs, provider }
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
export async function getWebProvider(): Promise<AbstractProvider> {
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

  const { urls, timeoutMs } = resolveRpc(override, chainConfig, process.env)

  const current = g.__explorer_provider
  if (current && current.key === providerKey(urls) && current.timeoutMs === timeoutMs) return current.provider

  return buildProvider({ urls, timeoutMs })
}
