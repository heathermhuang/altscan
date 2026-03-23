/**
 * GoPlus Security API client for BNBScan.
 * Free, no API key required for individual calls.
 * Chain ID: 56 (BSC mainnet)
 * Docs: https://docs.gopluslabs.io/reference/api-overview
 */

const BASE = 'https://api.gopluslabs.io/api/v1'
const CHAIN_ID = '56' // BSC

export type AddressRisk = {
  isContract: boolean
  isMalicious: boolean
  isPhishing: boolean
  isBlacklist: boolean
  riskItems: string[]   // human-readable risk flags
}

export type TokenSecurity = {
  isOpenSource: boolean
  isProxy: boolean
  isMintable: boolean
  isHoneypot: boolean
  sellTax: string       // e.g. "0.05" = 5%
  buyTax: string
  canTakeBackOwnership: boolean
  hiddenOwner: boolean
  isBlacklisted: boolean
  holderCount: number | null
  lpHolderCount: number | null
  riskLevel: 'safe' | 'warning' | 'danger'
}

export async function getAddressRisk(address: string): Promise<AddressRisk | null> {
  try {
    const res = await fetch(
      `${BASE}/address_security/${address}`,
      { next: { revalidate: 3600 } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      code: number
      result: {
        contract_address?: string
        malicious_address?: string
        phishing_activities?: string
        blacklist_doubt?: string
      }
    }
    if (data.code !== 1) return null
    const r = data.result
    const riskItems: string[] = []
    if (r.malicious_address === '1')   riskItems.push('Flagged as malicious address')
    if (r.phishing_activities === '1') riskItems.push('Known phishing activity')
    if (r.blacklist_doubt === '1')     riskItems.push('On security blacklist')

    return {
      isContract: !!r.contract_address,
      isMalicious: r.malicious_address === '1',
      isPhishing: r.phishing_activities === '1',
      isBlacklist: r.blacklist_doubt === '1',
      riskItems,
    }
  } catch {
    return null
  }
}

export async function getTokenSecurity(contractAddress: string): Promise<TokenSecurity | null> {
  try {
    const res = await fetch(
      `${BASE}/token_security/${CHAIN_ID}?contract_addresses=${contractAddress}`,
      { next: { revalidate: 3600 } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      code: number
      result: Record<string, {
        is_open_source?: string
        is_proxy?: string
        is_mintable?: string
        is_honeypot?: string
        sell_tax?: string
        buy_tax?: string
        can_take_back_ownership?: string
        hidden_owner?: string
        is_blacklisted?: string
        holder_count?: string
        lp_holder_count?: string
      }>
    }
    if (data.code !== 1) return null
    const r = data.result[contractAddress.toLowerCase()] ?? data.result[contractAddress]
    if (!r) return null

    const isHoneypot = r.is_honeypot === '1'
    const sellTaxNum = parseFloat(r.sell_tax ?? '0')
    const buyTaxNum  = parseFloat(r.buy_tax ?? '0')
    const hiddenOwner = r.hidden_owner === '1'

    let riskLevel: TokenSecurity['riskLevel'] = 'safe'
    if (isHoneypot || hiddenOwner || r.can_take_back_ownership === '1') riskLevel = 'danger'
    else if (sellTaxNum > 0.1 || buyTaxNum > 0.1 || r.is_mintable === '1') riskLevel = 'warning'

    return {
      isOpenSource: r.is_open_source === '1',
      isProxy: r.is_proxy === '1',
      isMintable: r.is_mintable === '1',
      isHoneypot,
      sellTax: r.sell_tax ?? '0',
      buyTax: r.buy_tax ?? '0',
      canTakeBackOwnership: r.can_take_back_ownership === '1',
      hiddenOwner,
      isBlacklisted: r.is_blacklisted === '1',
      holderCount: r.holder_count ? parseInt(r.holder_count) : null,
      lpHolderCount: r.lp_holder_count ? parseInt(r.lp_holder_count) : null,
      riskLevel,
    }
  } catch {
    return null
  }
}
