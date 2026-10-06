import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sourcify lookup must follow the configured chain. verifier.ts used to hardcode
 * BNB's chain id (56), so ethscan.io's /verify checked BNB Chain's records and answered
 * "not found on Sourcify for BSC chain ID 56" for every Ethereum contract.
 */

const get = vi.hoisted(() => vi.fn())
vi.mock('axios', () => ({ default: { get } }))

import { checkSourcify, triggerSourcifyVerification } from '@/lib/verifier'

const ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const CHAINS = [
  { chainId: 1, name: 'Ethereum' },
  { chainId: 56, name: 'BNB Chain' },
] as const

beforeEach(() => {
  get.mockReset()
})

describe('checkSourcify', () => {
  it.each(CHAINS)('queries Sourcify for chain $chainId', async ({ chainId }) => {
    get.mockResolvedValue({ data: [{ address: ADDRESS, status: 'perfect' }] })
    await checkSourcify(ADDRESS, chainId)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][1].params).toMatchObject({ addresses: ADDRESS, chainIds: chainId })
  })
})

describe('triggerSourcifyVerification', () => {
  it.each(CHAINS)('looks up chain $chainId and succeeds when Sourcify has the contract', async (chain) => {
    get.mockResolvedValue({ data: [{ address: ADDRESS, status: 'perfect' }] })
    await expect(triggerSourcifyVerification(ADDRESS, '', chain)).resolves.toEqual({ success: true })
    expect(get.mock.calls[0][1].params.chainIds).toBe(chain.chainId)
  })

  it.each(CHAINS)('names $name (chain ID $chainId) in the not-found error, never another chain', async (chain) => {
    get.mockResolvedValue({ data: [{ address: ADDRESS, status: 'false' }] })
    const result = await triggerSourcifyVerification(ADDRESS, '', chain)
    expect(result.success).toBe(false)
    expect(result.error).toContain(`Sourcify for ${chain.name} (chain ID ${chain.chainId})`)
    for (const other of CHAINS.filter((c) => c.chainId !== chain.chainId)) {
      expect(result.error).not.toContain(other.name)
      expect(result.error).not.toContain(`chain ID ${other.chainId}`)
    }
    expect(result.error).not.toMatch(/BSC/)
  })

  it('treats a Sourcify outage as not verified', async () => {
    get.mockRejectedValue(new Error('timeout'))
    const result = await triggerSourcifyVerification(ADDRESS, '', CHAINS[0])
    expect(result.success).toBe(false)
  })
})
