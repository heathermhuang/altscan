import axios from 'axios'
import type { ChainConfig } from '@altscan/chain-config'

const SOURCIFY_BASE = 'https://sourcify.dev/server'

/**
 * The slice of the chain config the verifier needs. Callers pass it in so no call site can
 * forget to pick a chain: this module once hardcoded BNB's id (56), so ethscan.io checked
 * BNB Chain's Sourcify records and could never verify an Ethereum contract.
 */
export type VerifierChain = Pick<ChainConfig, 'chainId' | 'name'>

export async function checkSourcify(address: string, chainId: number): Promise<{
  verified: boolean
  match?: 'full' | 'partial'
  source?: string
}> {
  try {
    const response = await axios.get(`${SOURCIFY_BASE}/check-by-addresses`, {
      params: {
        addresses: address,
        chainIds: chainId,
      },
      timeout: 5000,
    })

    const data = response.data
    if (!Array.isArray(data) || data.length === 0) {
      return { verified: false }
    }

    const result = data[0]
    if (!result || !result.status) {
      return { verified: false }
    }

    if (result.status === 'perfect') {
      return { verified: true, match: 'full', source: 'full' }
    }

    if (result.status === 'partial') {
      return { verified: true, match: 'partial', source: 'partial' }
    }

    return { verified: false }
  } catch {
    return { verified: false }
  }
}

export async function triggerSourcifyVerification(
  address: string,
  compilerVersion: string,
  chain: VerifierChain,
): Promise<{ success: boolean; error?: string }> {
  // POST to Sourcify is complex (requires source files), so for our purposes:
  // Just check if already verified and return the status
  const result = await checkSourcify(address, chain.chainId)
  if (result.verified) return { success: true }
  return {
    success: false,
    error: `Contract source not found on Sourcify for ${chain.name} (chain ID ${chain.chainId}). Upload source files to sourcify.dev first.`,
  }
}
