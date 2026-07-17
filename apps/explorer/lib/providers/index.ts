/**
 * Data-provider registry (spec §3.5). `getDataProvider()` is the ONLY way app
 * code reaches a historical-data provider; the concrete vendor stays behind
 * ProviderAdapter. Returns null when the chain configures none — a valid mode
 * (a brand-new chain indexes forward from launch and needs no provider).
 * NOTE: deliberately NOT named getProvider() — lib/rpc.ts already exports that
 * for the viem RPC client and both are used in app/address/[address]/page.tsx.
 */
import type { DataProviderConfig } from '@altscan/chain-config'
import { chainConfig } from '../chain'
import { createMoralisAdapter, getMoralisHealthState } from './moralis'
import type { ProviderAdapter } from './types'

export function resolveDataProvider(cfg: DataProviderConfig | null): ProviderAdapter | null {
  if (!cfg) return null
  switch (cfg.kind) {
    case 'moralis':
      return createMoralisAdapter(cfg)
  }
}

let singleton: ProviderAdapter | null | undefined
export function getDataProvider(): ProviderAdapter | null {
  if (singleton === undefined) singleton = resolveDataProvider(chainConfig.provider)
  return singleton
}

/** Limiter/health snapshot for /api/health — the response key stays `moralis`
 *  (admin-dashboard contract), sourced here so the route never imports the impl. */
export async function getDataProviderHealth(): Promise<Record<string, unknown>> {
  return getMoralisHealthState()
}

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
} from './types'
