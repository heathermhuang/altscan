/**
 * Moralis API client for BNBScan.
 * Provides historical wallet transaction data beyond what the local indexer has.
 * Chain: BSC (chain = '0x38')
 * Docs: https://docs.moralis.com/web3-data-api/evm/reference/wallet-api/get-wallet-history
 */

const BASE = 'https://deep-index.moralis.io/api/v2.2'
const CHAIN = '0x38' // BSC mainnet

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
}

export type MoralisToken = {
  tokenAddress: string
  symbol: string
  name: string
  logo: string | null
  decimals: number
  balanceFormatted: string
  usdValue: string | null
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
  const key = process.env.MORALIS_API_KEY
  if (!key) return null
  return { 'X-API-Key': key, 'Accept': 'application/json' }
}

export async function getWalletHistory(
  address: string,
  cursor?: string,
): Promise<{ txs: MoralisTx[]; cursor: string | null } | null> {
  const h = headers()
  if (!h) return null

  try {
    const url = new URL(`${BASE}/wallets/${address}/history`)
    url.searchParams.set('chain', CHAIN)
    url.searchParams.set('limit', '25')
    url.searchParams.set('include_internal_transactions', '0')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: h,
      next: { revalidate: 60 },
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
      }>
      cursor: string | null
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
      })),
      cursor: data.cursor ?? null,
    }
  } catch {
    return null
  }
}

export async function getTokenBalances(address: string): Promise<MoralisToken[]> {
  const h = headers()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/erc20?chain=${CHAIN}&limit=50`,
      { headers: h, next: { revalidate: 60 } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as Array<{
      token_address: string
      symbol: string
      name: string
      logo: string | null
      decimals: number
      balance_formatted: string
      usd_value: string | null
    }>
    return data.map(t => ({
      tokenAddress: t.token_address,
      symbol: t.symbol,
      name: t.name,
      logo: t.logo,
      decimals: t.decimals,
      balanceFormatted: t.balance_formatted,
      usdValue: t.usd_value,
    }))
  } catch {
    return []
  }
}

export async function getNfts(address: string): Promise<MoralisNft[]> {
  const h = headers()
  if (!h) return []

  try {
    const res = await fetch(
      `${BASE}/${address}/nft?chain=${CHAIN}&limit=20&media_items=false`,
      { headers: h, next: { revalidate: 120 } },
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
