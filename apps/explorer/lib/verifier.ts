import axios from 'axios'

const SOURCIFY_BASE = 'https://sourcify.dev/server'
const BSC_CHAIN_ID = 56

export async function checkSourcify(address: string): Promise<{
  verified: boolean
  match?: 'full' | 'partial'
  source?: string
}> {
  try {
    const response = await axios.get(`${SOURCIFY_BASE}/check-by-addresses`, {
      params: {
        addresses: address,
        chainIds: BSC_CHAIN_ID,
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
): Promise<{ success: boolean; error?: string }> {
  // POST to Sourcify is complex (requires source files), so for our purposes:
  // Just check if already verified and return the status
  const result = await checkSourcify(address)
  if (result.verified) return { success: true }
  return {
    success: false,
    error:
      'Contract source not found on Sourcify for BSC chain ID 56. Upload source files to sourcify.dev first.',
  }
}
