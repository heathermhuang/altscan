/**
 * Provider-neutral contracts for historical-data providers (spec §3.5).
 * A ProviderAdapter method NEVER throws and NEVER returns bare null — every
 * failure carries a reason so callers can degrade honestly (spec §3.5:
 * graceful degradation is mandatory; the June '26 failure mode was callers
 * being unable to tell "throttled" from "address has no history").
 */
export type ProviderFailReason =
  | 'not_configured'   // no API key / no provider for this chain
  | 'disabled'         // kill switch (MORALIS_DISABLED=true)
  | 'rate_limited'     // per-bucket budget exhausted
  | 'upstream_error'   // provider HTTP error, timeout, or cached negative

export type ProviderResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ProviderFailReason }

export type ProviderErc20Transfer = {
  fromAddress: string
  toAddress: string
  tokenAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDecimals: string
  value: string
  valueFormatted: string
  direction: string
}

export type ProviderTx = {
  hash: string
  blockNumber: string
  blockTimestamp: string
  fromAddress: string
  toAddress: string | null
  value: string          // in wei
  gasPrice: string
  gasUsed: string
  category: string       // e.g. 'token transfer', 'contract interaction', 'send'
  summary: string        // human-readable e.g. "Swapped 1.5 BNB for 250 CAKE"
  possibleSpam: boolean
  erc20Transfers: ProviderErc20Transfer[]
}

export type ProviderTokenBalance = {
  tokenAddress: string
  symbol: string
  name: string
  logo: string | null
  decimals: number
  balance: string
  balanceFormatted: string | null
  usdValue: string | null
}

export type ProviderTokenTransfer = {
  txHash: string
  /** Provider log index within the block. A4b (R3) keys backfilled transfers on
   *  (scope_address, tx_hash, log_index) — a stable identity that survives
   *  re-paging, unlike a positional counter.
   *
   *  `null` when the upstream row omits it or supplies a value that is not a
   *  non-negative integer. It is deliberately NOT `''`: a sentinel that is a
   *  valid `string` type-checks as a usable key component, so two absent values
   *  in the same tx would silently collide on the primary key. `null` forces
   *  every consumer to handle absence, and A4b's worker skips such rows.
   *
   *  Verified live 2026-07-18: Moralis supplies a numeric `log_index` on 25/25
   *  rows on both bsc and eth, so this should stay null in practice. */
  logIndex: string | null
  blockNumber: string
  blockTimestamp: string
  fromAddress: string
  toAddress: string
  tokenAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDecimals: string
  value: string
  valueFormatted: string
}

/**
 * The reduced projection the history API actually serves.
 *
 * Both provider-mapped and backfill-mapped rows are exactly this shape, so a
 * cached row and a live row are indistinguishable to the client and neither has
 * to fabricate fields the other lacks (the backfill tables never stored
 * gasPrice/gasUsed/erc20Transfers, and inventing gasPrice:'0' would be a lie
 * the UI could render).
 */
export type HistoryRow = Pick<ProviderTx,
  'hash' | 'blockNumber' | 'blockTimestamp' | 'fromAddress' | 'toAddress' |
  'value' | 'category' | 'summary' | 'possibleSpam'>

/** Same idea for token transfers. `tokenName` is deliberately absent: the
 *  backfill table does not store it, so serving it would be a lie on the
 *  cached path. */
export type TokenTransferRow = Pick<ProviderTokenTransfer,
  'txHash' | 'logIndex' | 'blockNumber' | 'blockTimestamp' | 'fromAddress' |
  'toAddress' | 'tokenAddress' | 'tokenSymbol' | 'tokenDecimals' | 'value' | 'valueFormatted'>

export type ProviderNft = {
  tokenAddress: string
  tokenId: string
  name: string
  symbol: string
  metadata: Record<string, unknown> | null
  imageUrl: string | null
}

export type ProviderHolder = {
  address: string
  balance: string
  balanceFormatted: string | null
  usdValue: string | null
  isContract: boolean
  percentage: string | null   // percentage_relative_to_total_supply
  label: string | null
}

export type AddressHistoryPage = { txs: ProviderTx[]; cursor: string | null; totalTxs: number }
export type TokenTransfersPage = { transfers: ProviderTokenTransfer[]; cursor: string | null }
export type TokenHoldersPage = { holders: ProviderHolder[]; totalSupply: string | null }

/** One historical-data provider (Moralis today; Covalent/Alchemy failover later).
 *  getInternalTxns joins in Track A5. */
export interface ProviderAdapter {
  readonly kind: string
  getAddressHistory(address: string, cursor?: string): Promise<ProviderResult<AddressHistoryPage>>
  getAddressTokenTransfers(address: string, cursor?: string): Promise<ProviderResult<TokenTransfersPage>>
  getAddressTokenBalances(address: string): Promise<ProviderResult<ProviderTokenBalance[]>>
  getAddressNfts(address: string): Promise<ProviderResult<ProviderNft[]>>
  getTokenHolders(tokenAddress: string): Promise<ProviderResult<TokenHoldersPage>>
  getTokenHolderCount(tokenAddress: string): Promise<ProviderResult<number>>
}
