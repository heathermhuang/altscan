/**
 * Moralis API client for BNBScan.
 * Provides historical wallet transaction data beyond what the local indexer has.
 * Chain: BSC (chain = '0x38')
 *
 * CU BUDGET — Free tier: 40,000 CU/day
 * Strategy:
 *   - Long cache TTLs (1hr history, 4hr holdings/NFTs) to avoid re-fetches
 *   - Small page sizes (limit=10) — enough to show useful data, minimizes CU
 *   - No separate getWalletStats call — derive tx count from history response
 *   - exclude_spam=true on token endpoints to skip noise
 *   - Only fetch for the active tab, never prefetch other tabs
 */

const BASE = 'https://deep-index.moralis.io/api/v2.2'
const CHAIN = '0x38' // BSC mainnet

// Cache TTLs (seconds) — longer = fewer CU, staler data
const CACHE_HISTORY   = 3600    // 1 hour — tx history changes slowly
const CACHE_BALANCES  = 3600    // 1 hour — token balances
const CACHE_NFTS      = 14400   // 4 hours — NFT holdings rarely change
const CACHE_TRANSFERS = 3600    // 1 hour — token transfer history

export type MoralisTx = {
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
  erc20Transfers: MoralisErc20Transfer[]
}

export type MoralisToken = {
  tokenAddress: string
  symbol: string
  name: string
  logo: string | null
  decimals: number
  balance: string
  balanceFormatted: string | null
  usdValue: string | null
}

export type MoralisErc20Transfer = {
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

export type MoralisNft = {
  tokenAddress: string
  tokenId: string
  name: string
  symbol: string
  metadata: Record<string, unknown> | null
  imageUrl: string | null
}

function headers() {
  if (process.env.MORALIS_DISABLED === 'true') return null
  const key = process.env.MORALIS_API_KEY
  if (!key) return null
  return { 'X-API-Key': key, 'Accept': 'application/json' }
}

/**
 * Get wallet transaction history. Also returns total tx count in the response
 * so we don't need a separate getWalletStats call (saves ~10 CU per address).
 * Cost: ~25 CU
 */
export async function getWalletHistory(
  address: string,
  cursor?: string,
): Promise<{ txs: MoralisTx[]; cursor: string | null; totalTxs: number } | null> {
  const h = headers()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/wallets/${address}/history`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '10')  // 10 is enough for display, saves CU vs 25
    url.searchParams.set('include_internal_transactions', '0')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      next: { revalidate: CACHE_HISTORY },
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      result: Array<{
        hash: string
        block_number: string
        block_timestamp: string
        from_address: string
        to_address: string | null
        value: string
        gas_price: string
        receipt_gas_used: string
        category: string
        summary: string
        possible_spam: boolean
        erc20_transfers?: Array<{
          from_address: string
          to_address: string
          contract_address: string
          token_name: string
          token_symbol: string
          token_decimals: string
          value: string
          value_formatted: string
          direction: string
        }>
      }>
      cursor: string | null
      total?: number  // Moralis returns total count in history response
    }

    return {
      txs: data.result.map(t => ({
        hash: t.hash,
        blockNumber: t.block_number,
        blockTimestamp: t.block_timestamp,
        fromAddress: t.from_address,
        toAddress: t.to_address,
        value: t.value,
        gasPrice: t.gas_price,
        gasUsed: t.receipt_gas_used,
        category: t.category,
        summary: t.summary,
        possibleSpam: t.possible_spam,
        erc20Transfers: (t.erc20_transfers ?? []).map(e => ({
          fromAddress: e.from_address,
          toAddress: e.to_address,
          tokenAddress: e.contract_address,
          tokenName: e.token_name,
          tokenSymbol: e.token_symbol,
          tokenDecimals: e.token_decimals,
          value: e.value,
          valueFormatted: e.value_formatted,
          direction: e.direction,
        })),
      })),
      cursor: data.cursor ?? null,
      totalTxs: data.total ?? data.result.length,
    }
  } catch {
    return null
  }
}

/**
 * Get ERC-20 token balances for an address.
 * Cost: ~25 CU. Cached for 1 hour.
 */
export async function getTokenBalances(address: string): Promise<MoralisToken[]> {
  const h = headers()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/erc20?chain=${CHAIN}&limit=20&exclude_spam=true`,
      { headers: h, next: { revalidate: CACHE_BALANCES } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as Array<{
      token_address: string
      symbol: string
      name: string
      logo: string | null
      decimals: number
      balance: string
      balance_formatted: string | null
      usd_value: string | null
    }>
    return data.map(t => ({
      tokenAddress: t.token_address,
      symbol: t.symbol,
      name: t.name,
      logo: t.logo,
      decimals: t.decimals,
      balance: t.balance ?? '0',
      balanceFormatted: t.balance_formatted ?? null,
      usdValue: t.usd_value,
    }))
  } catch {
    return []
  }
}

/**
 * @deprecated Use getWalletHistory().totalTxs instead — saves a separate API call (~10 CU)
 */
export async function getWalletStats(address: string): Promise<{ txCount: number } | null> {
  // Eliminated — tx count is now derived from getWalletHistory response
  return null
}

export type MoralisTokenTransfer = {
  txHash: string
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
 * Get ERC-20 token transfer history for an address.
 * Cost: ~25 CU. Cached for 1 hour.
 */
export async function getTokenTransfers(
  address: string,
  cursor?: string,
): Promise<{ transfers: MoralisTokenTransfer[]; cursor: string | null } | null> {
  const h = headers()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/wallets/${address}/erc20-transfers`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '10')  // 10 instead of 25
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      next: { revalidate: CACHE_TRANSFERS },
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      result: Array<{
        transaction_hash: string
        block_number: string
        block_timestamp: string
        from_address: string
        to_address: string
        contract_address: string
        token_name: string
        token_symbol: string
        token_decimals: string
        value: string
        value_formatted: string
      }>
      cursor: string | null
    }

    return {
      transfers: data.result.map(t => ({
        txHash: t.transaction_hash,
        blockNumber: t.block_number,
        blockTimestamp: t.block_timestamp,
        fromAddress: t.from_address,
        toAddress: t.to_address,
        tokenAddress: t.contract_address,
        tokenName: t.token_name,
        tokenSymbol: t.token_symbol,
        tokenDecimals: t.token_decimals,
        value: t.value,
        valueFormatted: t.value_formatted,
      })),
      cursor: data.cursor ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Get NFTs owned by an address.
 * Cost: ~25 CU. Cached for 4 hours (NFTs rarely change).
 */
export async function getNfts(address: string): Promise<MoralisNft[]> {
  const h = headers()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/nft?chain=${CHAIN}&limit=10&media_items=false&exclude_spam=true`,
      { headers: h, next: { revalidate: CACHE_NFTS } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as {
      result: Array<{
        token_address: string
        token_id: string
        name: string
        symbol: string
        metadata: string | null
        media?: { original_media_url?: string }
      }>
    }
    return data.result.map(n => {
      let metadata: Record<string, unknown> | null = null
      try { metadata = n.metadata ? JSON.parse(n.metadata) : null } catch { /* ignore */ }
      return {
        tokenAddress: n.token_address,
        tokenId: n.token_id,
        name: n.name,
        symbol: n.symbol,
        metadata,
        imageUrl: (metadata?.image as string) ?? n.media?.original_media_url ?? null,
      }
    })
  } catch {
    return []
  }
}
