import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Two bugs, one module:
 *  1. The lookup hardcoded BNB's chain id (56), so ethscan.io's /verify checked BNB Chain's
 *     records and answered "not found on Sourcify for BSC chain ID 56" for every Ethereum
 *     contract. The chain is now a parameter and the error names it.
 *  2. It called Sourcify API v1 (/check-by-addresses), which sourcify.dev removed: every call
 *     404'd, was swallowed as "not verified", and /verify could not succeed on either chain.
 *     It now calls v2 (/v2/contract/{chainId}/{address}; 404 = not verified).
 */

const get = vi.hoisted(() => vi.fn())
vi.mock('axios', () => ({ default: { get } }))

import { checkSourcify, triggerSourcifyVerification } from '@/lib/verifier'
import { resetSwallowThrottle } from '@/lib/observability'

const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const CHAINS = [
  { chainId: 1, name: 'Ethereum' },
  { chainId: 56, name: 'BNB Chain' },
] as const

const COMPILER = '0.4.18+commit.9cf6e910' // what Sourcify reports for USDT, as `fields=compilation` returns it
const NO_COMPILATION = Symbol('no compilation block')
const verified = (match: 'match' | 'exact_match', chainId: number, compilation: unknown = { compilerVersion: COMPILER, language: 'Solidity' }) => ({
  status: 200,
  data: {
    match, creationMatch: match, runtimeMatch: match, chainId: String(chainId), address: ETH_USDT,
    ...(compilation === NO_COMPILATION ? {} : { compilation }),
  },
})
const notVerified = { status: 404, data: { match: null, creationMatch: null, runtimeMatch: null } }

beforeEach(() => {
  get.mockReset()
  resetSwallowThrottle()
})

describe('checkSourcify', () => {
  it.each(CHAINS)('requests the v2 contract endpoint for chain $chainId', async ({ chainId }) => {
    get.mockResolvedValue(verified('match', chainId))
    await checkSourcify(ETH_USDT, chainId)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe(`https://sourcify.dev/server/v2/contract/${chainId}/${ETH_USDT}`)
  })

  it('maps exact_match to full and match to partial', async () => {
    get.mockResolvedValueOnce(verified('exact_match', 1))
    await expect(checkSourcify(ETH_USDT, 1)).resolves.toEqual({ verified: true, match: 'full', source: 'full', compilerVersion: COMPILER })
    get.mockResolvedValueOnce(verified('match', 1))
    await expect(checkSourcify(ETH_USDT, 1)).resolves.toEqual({ verified: true, match: 'partial', source: 'partial', compilerVersion: COMPILER })
  })

  it('asks Sourcify for the compilation block, the only source of the compiler version', async () => {
    get.mockResolvedValue(verified('match', 1))
    await checkSourcify(ETH_USDT, 1)
    expect(get.mock.calls[0][1].params).toEqual({ fields: 'compilation' })
  })

  it('returns compilerVersion exactly as Sourcify reports it', async () => {
    get.mockResolvedValue(verified('match', 1, { compilerVersion: '0.8.26+commit.8a97fa7a', language: 'Solidity' }))
    expect((await checkSourcify(ETH_USDT, 1)).compilerVersion).toBe('0.8.26+commit.8a97fa7a')
  })

  it.each([
    ['no compilation block', NO_COMPILATION],
    ['no compilerVersion in it', { language: 'Solidity' }],
    ['an empty compilerVersion', { compilerVersion: '' }],
    ['a non-string compilerVersion', { compilerVersion: 8 }],
  ])('compilerVersion is null (still verified) with %s', async (_label, compilation) => {
    get.mockResolvedValue(verified('match', 1, compilation))
    await expect(checkSourcify(ETH_USDT, 1)).resolves.toMatchObject({ verified: true, compilerVersion: null })
  })

  it('treats 404 as not verified, quietly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    get.mockResolvedValue(notVerified)
    await expect(checkSourcify(ETH_USDT, 1)).resolves.toEqual({ verified: false })
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('only 200 and 404 are answers; anything else is a failure that is logged, not silent', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    get.mockRejectedValue(new Error('Request failed with status code 500'))
    await expect(checkSourcify(ETH_USDT, 1)).resolves.toEqual({ verified: false })
    expect(err).toHaveBeenCalledWith('[verify/sourcify]', expect.any(String))
    const { validateStatus } = get.mock.calls[0][1]
    expect([200, 404].every(validateStatus)).toBe(true)
    expect([301, 400, 429, 500, 503].some(validateStatus)).toBe(false)
    err.mockRestore()
  })
})

describe('triggerSourcifyVerification', () => {
  it('succeeds with compilerVersion null when Sourcify reports none', async () => {
    get.mockResolvedValue(verified('match', 1, NO_COMPILATION))
    await expect(triggerSourcifyVerification(ETH_USDT, CHAINS[0])).resolves.toEqual({ success: true, compilerVersion: null })
  })

  it.each(CHAINS)('looks up chain $chainId and succeeds when Sourcify has the contract', async (chain) => {
    get.mockResolvedValue(verified('match', chain.chainId))
    await expect(triggerSourcifyVerification(ETH_USDT, chain)).resolves.toEqual({ success: true, compilerVersion: COMPILER })
    expect(get.mock.calls[0][0]).toContain(`/v2/contract/${chain.chainId}/`)
  })

  it.each(CHAINS)('names $name (chain ID $chainId) in the not-found error, never another chain', async (chain) => {
    get.mockResolvedValue(notVerified)
    const result = await triggerSourcifyVerification(ETH_USDT, chain)
    expect(result.success).toBe(false)
    expect(result.error).toContain(`Sourcify for ${chain.name} (chain ID ${chain.chainId})`)
    for (const other of CHAINS.filter((c) => c.chainId !== chain.chainId)) {
      expect(result.error).not.toContain(other.name)
      expect(result.error).not.toContain(`chain ID ${other.chainId}`)
    }
    expect(result.error).not.toMatch(/BSC/)
  })
})
