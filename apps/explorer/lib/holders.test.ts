import { describe, expect, it } from 'vitest'
import { holdersFromProvider } from './holders'
import type { ProviderResult, TokenHoldersPage } from './providers'

const page = (holders: TokenHoldersPage['holders']): ProviderResult<TokenHoldersPage> =>
  ({ ok: true, data: { holders, totalSupply: '100' } })
const H = { address: '0xa', balance: '5', balanceFormatted: '5', usdValue: '10', isContract: false, percentage: '5', label: null }

describe('holdersFromProvider', () => {
  it('maps an ok result with holders + ok count', () => {
    const r = holdersFromProvider(page([H]), { ok: true, data: 42 })
    expect(r).toEqual({
      holders: [{ addr: '0xa', balance: '5', usdValue: '10', isContract: false, label: null }],
      holderCount: 42,
      source: 'moralis',
    })
  })
  it('returns null on provider failure → caller falls back to the local estimate', () => {
    expect(holdersFromProvider({ ok: false, reason: 'rate_limited' }, null)).toBeNull()
  })
  it('returns null on ok-but-empty holders', () => {
    expect(holdersFromProvider(page([]), null)).toBeNull()
  })
  it('failed count degrades to holderCount:null, not a failure', () => {
    const r = holdersFromProvider(page([H]), { ok: false, reason: 'upstream_error' })
    expect(r?.holderCount).toBeNull()
  })
})
