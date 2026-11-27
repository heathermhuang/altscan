/**
 * GoPlus Security API client for BNBScan.
 * Free, no API key required for individual calls.
 * Chain ID: 56 (BSC mainnet)
 * Docs: https://docs.gopluslabs.io/reference/api-overview
 */

import { createTtlCache } from './ttl-cache'

const BASE = 'https://api.gopluslabs.io/api/v1'

export type AddressRisk = {
  isContract: boolean
  isMalicious: boolean
  isPhishing: boolean
  isBlacklist: boolean
  riskItems: string[]   // human-readable risk flags
}

const riskCache = createTtlCache<AddressRisk>({ name: 'goplus-address-risk', max: 5_000, ttlMs: 10 * 60 * 1000 })

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
 * that is not a verdict). Only verdicts are cached, in memory, for 10 minutes and at most 5,000: Next's
 * fetch cache, used before, kept any 200 answer for 5 minutes, an error code or a partial result included.
 */
export async function getAddressRisk(address: string): Promise<AddressRisk | null> {
  const key = address.toLowerCase()
  const hit = riskCache.get(key)
  if (hit) return hit
  try {
    const res = await fetch(`${BASE}/address_security/${key}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
    if (!res.ok) return null
    const risk = parseAddressSecurity(await res.json())
    if (risk) {
      riskCache.set(key, risk)
    }
    return risk
  } catch {
    return null
  }
}
