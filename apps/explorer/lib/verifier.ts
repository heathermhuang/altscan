import axios from 'axios'
import type { ChainConfig } from '@altscan/chain-config'
import { swallow } from '@/lib/observability'

const SOURCIFY_BASE = 'https://sourcify.dev/server'

/**
 * The slice of the chain config the verifier needs. Callers pass it in so no call site can
 * forget to pick a chain: this module once hardcoded BNB's id (56), so ethscan.io checked
 * BNB Chain's Sourcify records and could never verify an Ethereum contract.
 */
export type VerifierChain = Pick<ChainConfig, 'chainId' | 'name'>

/**
 * Sourcify API v2: `GET /v2/contract/{chainId}/{address}` is 200 with `match` of
 * `exact_match` (v1 "perfect") or `match` (v1 "partial") when the contract is verified, and
 * 404 when it is not. The v1 `/check-by-addresses` this used to call was removed from
 * sourcify.dev: it 404s for every address on every chain, which this function swallowed as
 * "not verified", so /verify could not succeed on either product.
 *
 * `fields=compilation` adds `compilation.compilerVersion` (e.g. "0.4.18+commit.9cf6e910").
 * That is the ONLY trustworthy compiler version for a verified contract: callers must store
 * it, never a value the HTTP client supplied.
 */
export async function checkSourcify(address: string, chainId: number): Promise<{
  verified: boolean
  match?: 'full' | 'partial'
  source?: string
  /** Sourcify's compiler version for the verified contract; null when it reports none. */
  compilerVersion?: string | null
}> {
  try {
    const response = await axios.get(`${SOURCIFY_BASE}/v2/contract/${chainId}/${address}`, {
      params: { fields: 'compilation' },
      timeout: 5000,
      // 404 is Sourcify's answer for "not verified"; anything else non-200 is a real failure.
      validateStatus: (status) => status === 200 || status === 404,
    })
    if (response.status !== 200) return { verified: false }

    const match = response.data?.match
    const reported = response.data?.compilation?.compilerVersion
    const compilerVersion = typeof reported === 'string' && reported !== '' ? reported : null
    if (match === 'exact_match') return { verified: true, match: 'full', source: 'full', compilerVersion }
    if (match === 'match') return { verified: true, match: 'partial', source: 'partial', compilerVersion }
    return { verified: false }
  } catch (e) {
    swallow('verify/sourcify', e)
    return { verified: false }
  }
}

export async function triggerSourcifyVerification(
  address: string,
  chain: VerifierChain,
): Promise<{ success: boolean; compilerVersion?: string | null; error?: string }> {
  // POST to Sourcify is complex (requires source files), so for our purposes:
  // Just check if already verified and return the status
  const result = await checkSourcify(address, chain.chainId)
  if (result.verified) return { success: true, compilerVersion: result.compilerVersion ?? null }
  return {
    success: false,
    error: `Contract source not found on Sourcify for ${chain.name} (chain ID ${chain.chainId}). Upload source files to sourcify.dev first.`,
  }
}
