/**
 * Data-provider registry (spec §3.5). The concrete vendor stays behind
 * ProviderAdapter; this package is the ONLY place the vendor API is reachable
 * (guardrail-tested in ./guardrail.test.ts).
 *
 * Lifted out of apps/explorer/lib/providers in A4b-0 so the INDEXER can import
 * it too (the lazy-backfill worker runs indexer-side). Deliberately free of
 * app-local state: `resolveDataProvider` takes its config and context as
 * arguments rather than reading a chain singleton, so the explorer and the
 * indexer can each supply their own. It is also side-effect-free — the
 * explorer's cache-registry registration lives in its shim, not here, because
 * the indexer has no cache registry.
 */
import type { DataProviderConfig } from '@altscan/chain-config'
import { createMoralisAdapter, getMoralisHealthState } from './moralis'
import type { ProviderAdapter } from './types'

/** Host-supplied context. `currency` is the native ticker (e.g. "BNB") used
 *  only for human-readable transfer summaries. */
export type ProviderContext = { currency?: string }

/** Resolve a provider config into an adapter. Returns null when the chain
 *  configures none — a valid mode (a brand-new chain indexes forward from
 *  launch and needs no provider). */
export function resolveDataProvider(
  cfg: DataProviderConfig | null,
  ctx?: ProviderContext,
): ProviderAdapter | null {
  if (!cfg) return null
  switch (cfg.kind) {
    case 'moralis':
      return createMoralisAdapter(cfg, ctx)
  }
}

/** Limiter/health snapshot for /api/health — the response key stays `moralis`
 *  (admin-dashboard contract), sourced here so the route never imports the impl. */
export async function getDataProviderHealth(): Promise<Record<string, unknown>> {
  return getMoralisHealthState()
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
  HistoryRow,
  TokenTransferRow,
  TokenHoldersPage,
  TokenTransfersPage,
} from './types'
