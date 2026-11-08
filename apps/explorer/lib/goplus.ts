/**
 * GoPlus Security API client for BNBScan.
 * Free, no API key required for individual calls.
 * Chain ID: 56 (BSC mainnet)
 * Docs: https://docs.gopluslabs.io/reference/api-overview
 */

import { registerCache } from './cache-registry'

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

const RISK_TTL_MS = 10 * 60 * 1000
const RISK_MAX_ENTRIES = 5_000
const riskCache = new Map<string, { risk: AddressRisk; expires: number }>()
registerCache('goplus-address-risk', () => riskCache.size)

const RISK_FLAGS = ['malicious_address', 'phishing_activities', 'blacklist_doubt'] as const
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Pure. GoPlus's answer as a verdict, or null when it is not one: an error code, a missing result, or a risk flag
 * that is absent or anything but "0"/"1". A missing flag is not a clean bill: it is no answer, so it is neither shown
 * as safe nor cached.
 */
export function parseAddressSecurity(data: unknown): AddressRisk | null {
  if (!isRecord(data) || data.code !== 1 || !isRecord(data.result)) return null
  const r = data.result
  if (!RISK_FLAGS.every(f => r[f] === '0' || r[f] === '1')) return null
  const riskItems: string[] = []
  if (r.malicious_address === '1')   riskItems.push('Flagged as malicious address')
  if (r.phishing_activities === '1') riskItems.push('Known phishing activity')
  if (r.blacklist_doubt === '1')     riskItems.push('On security blacklist')
  return {
    // "0" is a string too, so not `!!r.contract_address`.
    isContract: r.contract_address === '1',
    isMalicious: r.malicious_address === '1',
    isPhishing: r.phishing_activities === '1',
    isBlacklist: r.blacklist_doubt === '1',
    riskItems,
  }
}

/**
 * The address's GoPlus verdict, or null when there is none to give (GoPlus failed, refused, or answered something
 * that is not a verdict). Only verdicts are cached, in memory, for RISK_TTL_MS and at most RISK_MAX_ENTRIES: Next's
 * fetch cache, used before, kept any 200 answer for 5 minutes, an error code or a partial result included.
 */
export async function getAddressRisk(address: string): Promise<AddressRisk | null> {
  const key = address.toLowerCase()
  const hit = riskCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.risk
  if (hit) riskCache.delete(key)
  try {
    const res = await fetch(`${BASE}/address_security/${key}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
    if (!res.ok) return null
    const risk = parseAddressSecurity(await res.json())
    if (risk) {
      if (riskCache.size >= RISK_MAX_ENTRIES) riskCache.delete(riskCache.keys().next().value!)
      riskCache.set(key, { risk, expires: Date.now() + RISK_TTL_MS })
    }
    return risk
  } catch {
    return null
  }
}

export async function getTokenSecurity(contractAddress: string): Promise<TokenSecurity | null> {
  try {
    const res = await fetch(
      `${BASE}/token_security/${CHAIN_ID}?contract_addresses=${contractAddress}`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 300 } },
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
