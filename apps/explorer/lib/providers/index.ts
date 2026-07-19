/**
 * Explorer-side provider shim. The adapter itself lives in @altscan/providers
 * (lifted in A4b-0 so the indexer's lazy-backfill worker can import it too);
 * this file holds the two concerns that are genuinely explorer-only:
 *
 *  1. the `getDataProvider()` singleton, which binds the package's pure
 *     `resolveDataProvider` to THIS app's chain singleton, and
 *  2. bot detection, which only applies to inbound web requests.
 *
 * It also owns the cache-registry registration that used to live in
 * moralis.ts. That has to happen here: the package must stay side-effect-free
 * because the indexer imports it and has no cache registry, but the explorer
 * still needs the kv fallback size reported to its memory monitor and
 * /api/health (the OOM guard).
 *
 * NOTE: deliberately NOT named getProvider() — lib/rpc.ts already exports that
 * for the viem RPC client and both are used in app/address/[address]/page.tsx.
 */
import { chainConfig } from '../chain'
import { registerCache } from '../cache-registry'
import { getKvFallbackSize } from '@altscan/explorer-core'
import { resolveDataProvider, getDataProviderHealth } from '@altscan/providers'
import type { ProviderAdapter } from '@altscan/providers'

// Report the in-memory kv fallback size to the health endpoint / memory monitor.
// 0 whenever Redis is serving the cache (BNBScan), bounded otherwise (EthScan).
registerCache('moralis', getKvFallbackSize)

let singleton: ProviderAdapter | null | undefined
export function getDataProvider(): ProviderAdapter | null {
  if (singleton === undefined) {
    singleton = resolveDataProvider(chainConfig.provider, { currency: chainConfig.currency })
  }
  return singleton
}

/** Limiter/health snapshot for /api/health — the response key stays `moralis`
 *  (admin-dashboard contract), sourced from the package so the route never
 *  imports the impl. */
export { getDataProviderHealth }

/** Bots never trigger provider spend. Distinct from lib/bot-policy.ts (the
 *  crawl/robots policy): this list ALSO matches the retrieval-allowed AI
 *  fetchers — welcome on pages, but they get the local-index view, zero CU. */
const BOT_PATTERNS = /bot|crawl|spider|slurp|baiduspider|yandex|sogou|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|chatgpt-user|perplexity-user|claude-user/i

/**
 * Check if the current request is from a bot. Call from address/token pages
 * before triggering any provider calls.
 */
export function isBotRequest(userAgent: string | null): boolean {
  if (!userAgent) return false  // no UA in SSR context = allow (rate limiter still protects)
  return BOT_PATTERNS.test(userAgent)
}

export type {
  AddressHistoryPage,
  ProviderAdapter,
  ProviderErc20Transfer,
  ProviderFailReason,
  ProviderHolder,
  ProviderNft,
  ProviderResult,
  ProviderTokenBalance,
  ProviderTokenTransfer,
  ProviderTx,
  TokenHoldersPage,
  TokenTransfersPage,
} from '@altscan/providers'
