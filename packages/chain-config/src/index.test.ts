import { describe, expect, it } from 'vitest'
import { CHAINS, isBackfillEnabled, type ChainConfig } from './index'

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

describe('isBackfillEnabled — per-chain config with a BACKFILL_ENABLED env override', () => {
  const OFF = CHAINS.bnb // provider.backfill.enabled === false (shipped dark)
  const ON: ChainConfig = {
    ...CHAINS.bnb,
    provider: { kind: 'moralis', moralisChain: '0x38', backfill: { enabled: true } },
  }

  it('falls back to the per-chain config when BACKFILL_ENABLED is unset', () => {
    expect(isBackfillEnabled(OFF, {})).toBe(false)
    expect(isBackfillEnabled(ON, {})).toBe(true)
  })

  it('BACKFILL_ENABLED=true|1 forces ON even when the config says false (no-deploy enable)', () => {
    expect(isBackfillEnabled(OFF, { BACKFILL_ENABLED: 'true' })).toBe(true)
    expect(isBackfillEnabled(OFF, { BACKFILL_ENABLED: '1' })).toBe(true)
  })

  it('BACKFILL_ENABLED=0|false forces OFF even when the config says true (kill switch, 0 kept for back-compat)', () => {
    expect(isBackfillEnabled(ON, { BACKFILL_ENABLED: '0' })).toBe(false)
    expect(isBackfillEnabled(ON, { BACKFILL_ENABLED: 'false' })).toBe(false)
  })

  it('ignores non-strict values and falls through to the config (fails safe)', () => {
    for (const v of ['TRUE', 'yes', '2', '', 'on', 'off']) {
      expect(isBackfillEnabled(OFF, { BACKFILL_ENABLED: v }), v).toBe(false)
      expect(isBackfillEnabled(ON, { BACKFILL_ENABLED: v }), v).toBe(true)
    }
  })

  it('treats an absent backfill object as OFF by default, still overridable by env', () => {
    const absent: ChainConfig = { ...CHAINS.bnb, provider: { kind: 'moralis', moralisChain: '0x38' } }
    expect(isBackfillEnabled(absent, {})).toBe(false)
    expect(isBackfillEnabled(absent, { BACKFILL_ENABLED: 'true' })).toBe(true)
  })
})

// The token_transfers whale partial indexes (ensure-schema.ts) and the whale
// queries read one field, `indexFloor`, and render it as a LITERAL: Postgres only
// uses a partial index when it can prove the query implies the predicate, and a
// bound parameter cannot prove it. The value is 100x the display threshold so the
// index holds only whale-size rows. It is data, not a formula, because it is
// spliced into DDL — but the formula is pinned here so an edit to minValue cannot
// drift away from it.
describe('whale token indexFloor', () => {
  const tracked = (key: 'bnb' | 'eth') => [CHAINS[key].whales.wrapped, ...CHAINS[key].whales.stablecoins]

  it.each(['bnb', 'eth'] as const)('%s: every tracked token floors at exactly 100x its minValue', (key) => {
    for (const t of tracked(key)) {
      expect(t.indexFloor, `${key} ${t.symbol}`).toMatch(/^[0-9]+$/)
      expect(BigInt(t.indexFloor), `${key} ${t.symbol}`).toBe(100n * BigInt(t.minValue))
    }
  })

  it('names the floors in whole tokens: $100k stables, 100 WBNB, 50 WETH', () => {
    const bnb = CHAINS.bnb.whales
    const eth = CHAINS.eth.whales
    expect(bnb.stablecoins.map(s => [s.symbol, s.indexFloor])).toEqual([
      ['USDT', '100000000000000000000000'], // 100,000 x 10^18
      ['USDC', '100000000000000000000000'],
    ])
    expect(bnb.wrapped.indexFloor).toBe('100000000000000000000') // 100 WBNB
    expect(eth.stablecoins.map(s => [s.symbol, s.indexFloor])).toEqual([
      ['USDT', '100000000000'], // 100,000 x 10^6
      ['USDC', '100000000000'],
    ])
    expect(eth.wrapped.indexFloor).toBe('50000000000000000000') // 50 WETH
  })
})
