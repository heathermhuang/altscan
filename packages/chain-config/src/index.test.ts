import { describe, expect, it } from 'vitest'
import { CHAINS } from './index'

describe('chain-config data provider', () => {
  it('BSC and ETH both configure a moralis data provider with their hex chain ids', () => {
    expect(CHAINS.bnb.provider).toEqual({
      kind: 'moralis', moralisChain: '0x38', backfill: { enabled: false },
    })
    expect(CHAINS.eth.provider).toEqual({
      kind: 'moralis', moralisChain: '0x1', backfill: { enabled: false },
    })
  })

  it('a chain with no provider is representable (forward-only indexing mode)', () => {
    const cfg = { ...CHAINS.bnb, provider: null }
    expect(cfg.provider).toBeNull()
  })

  it('moralisChain no longer exists as a top-level field (moved into provider)', () => {
    expect('moralisChain' in CHAINS.bnb).toBe(false)
    expect('moralisChain' in CHAINS.eth).toBe(false)
  })
})

describe('backfill config (Track A4b)', () => {
  it('both chains declare backfill DISABLED — A4b ships dark', () => {
    // The whole of A4b-1 is inert until these flip. Enabling is a deliberate,
    // per-chain act (ETH first, per the rollout), never a default.
    expect(CHAINS.bnb.provider?.backfill?.enabled).toBe(false)
    expect(CHAINS.eth.provider?.backfill?.enabled).toBe(false)
  })

  it('a chain may omit backfill entirely (A4a passthrough-only)', () => {
    // Absent must be as safe as false — a new chain that never sets the field
    // must not accidentally opt into provider spend.
    const cfg: (typeof CHAINS)['bnb'] = {
      ...CHAINS.bnb,
      provider: { kind: 'moralis', moralisChain: '0x38' },
    }
    expect(cfg.provider?.backfill?.enabled ?? false).toBe(false)
  })
})
