import { describe, it, expect } from 'vitest'
import { HOLDER_LABELS, holdersPhrase } from './holder-labels'

// A token has two holder counts that disagree by orders of magnitude (USDT on BNB: 835,871 vs 79,823,380):
// the explorer's own index, which can lag, and the data provider's total. Neither may be shown bare.
describe('holder labels', () => {
  it('has exactly one label per source', () => {
    expect(HOLDER_LABELS.indexed.phrase).toBe('indexed holders')
    expect(HOLDER_LABELS.provider.phrase).toBe('holders (Moralis)')
    expect(HOLDER_LABELS.indexed.heading).toBe('Indexed holders')
    expect(HOLDER_LABELS.provider.heading).toBe('Holders (Moralis)')
  })

  it('writes a count with its label', () => {
    expect(holdersPhrase(835871, 'indexed')).toBe('835,871 indexed holders')
    expect(holdersPhrase(79823380, 'provider')).toBe('79,823,380 holders (Moralis)')
  })

  it('explains each source in a tooltip', () => {
    expect(HOLDER_LABELS.indexed.title).toMatch(/this explorer/i)
    expect(HOLDER_LABELS.provider.title).toMatch(/Moralis/)
  })
})
