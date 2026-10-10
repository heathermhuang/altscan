import { describe, expect, it } from 'vitest'
import { validatorDisplays } from '@/lib/validator-display'
import { shortenAddress } from '@/lib/address-display'

const A = '0x75b851a27d7101438f45fce31816501193239a83'
const B = '0x37e9627a91dd13e453246856d58797ad6583d762'
const C = '0xd3b0d838ccceae7ebf1781d11d1bb741db7fe1a7'
const RUN = new Date('2026-10-10T10:00:00Z')    // one syncer run: every row it wrote shares this updatedAt
const OLDER = new Date('2026-10-09T10:00:00Z')  // a row an earlier run wrote and a later one no longer touches
const row = (address: string, moniker: string | null, votingPower = '5000000000000000000', status = 'active', updatedAt = RUN) =>
  ({ address, moniker, votingPower, status, updatedAt })

describe('validatorDisplays: names', () => {
  it('shows a real moniker as stored', () => {
    expect(validatorDisplays([row(A, 'Figment')])[0].name).toBe('Figment')
  })

  it('replaces the indexer\'s "Validator N" placeholder with the short address', () => {
    expect(validatorDisplays([row(A, 'Validator 35')])[0].name).toBe(shortenAddress(A))
  })

  it('treats an empty or whitespace-only moniker as a placeholder', () => {
    const [empty, blank, nul] = validatorDisplays([row(A, ''), row(B, '   '), row(C, null)])
    expect(empty.name).toBe(shortenAddress(A))
    expect(blank.name).toBe(shortenAddress(B))
    expect(nul.name).toBe(shortenAddress(C))
  })

  it('does not mistake a moniker that merely starts with "Validator" for a placeholder', () => {
    const names = validatorDisplays([row(A, 'Validator Labs'), row(B, 'Validator 7 Capital'), row(C, 'validator 9')]).map(d => d.name)
    expect(names).toEqual(['Validator Labs', 'Validator 7 Capital', 'validator 9'])
  })

  it('appends the short address to every member of a duplicated name, case-insensitively', () => {
    const [a, b, c] = validatorDisplays([row(A, 'Ankr'), row(B, 'ankr'), row(C, 'Figment')])
    expect(a.name).toBe(`Ankr ${shortenAddress(A)}`)
    expect(b.name).toBe(`ankr ${shortenAddress(B)}`)
    expect(c.name).toBe('Figment')
  })

  it('leaves a unique name alone even when a placeholder sits beside it', () => {
    const [a, b] = validatorDisplays([row(A, 'Ankr'), row(B, 'Validator 2')])
    expect(a.name).toBe('Ankr')
    expect(b.name).toBe(shortenAddress(B))
  })

  it('returns one entry per row, in order', () => {
    expect(validatorDisplays([])).toEqual([])
    expect(validatorDisplays([row(A, 'x'), row(B, 'y'), row(C, 'z')]).map(d => d.name)).toEqual(['x', 'y', 'z'])
  })
})

describe('validatorDisplays: status', () => {
  it('keeps "active" for a validator with voting power', () => {
    expect(validatorDisplays([row(A, 'Figment')])[0].status).toEqual({ label: 'active', variant: 'success' })
  })

  it('reads "No stake" with a neutral badge, never active, at voting power 0', () => {
    for (const power of ['0', '0.0000', '']) {
      // beside a row with power, so this is an ordinary run and not the ValidatorSet fallback
      expect(validatorDisplays([row(A, 'Squirrel', power), row(B, 'Figment')])[0].status).toEqual({ label: 'No stake', variant: 'default' })
    }
  })

  it('keeps jailed as jailed: that is a stronger fact than having no stake', () => {
    expect(validatorDisplays([row(A, 'x', '0', 'jailed')])[0].status).toEqual({ label: 'jailed', variant: 'fail' })
    expect(validatorDisplays([row(A, 'x', '9', 'jailed')])[0].status).toEqual({ label: 'jailed', variant: 'fail' })
  })

  it('shows any other stored status as a neutral badge', () => {
    expect(validatorDisplays([row(A, 'x', '9', 'inactive')])[0].status).toEqual({ label: 'inactive', variant: 'default' })
  })
})

// apps/indexer/src/validator-syncer.ts falls back to the ValidatorSet contract when StakeHub fails and
// upserts the whole active set with votingPower 0 in one run, so every row shares one updatedAt. Those
// zeros are "unknown", not "no stake": a table whose newest rows are all 0 is such a run.
describe('validatorDisplays: voting power 0 in the ValidatorSet fallback run', () => {
  const ZERO = '0'
  const power = '5000000000000000000'
  const unknown = (stored: string) => ({ label: stored, variant: stored === 'active' ? 'success' : 'default' })

  it('normal run: stale zero rows read "No stake"; current rows with power are unchanged', () => {
    const out = validatorDisplays([row(A, 'Figment', power, 'active', RUN), row(B, 'Stale', ZERO, 'active', OLDER), row(C, 'Old', ZERO, 'active', OLDER)])
    expect(out.map(d => d.status)).toEqual([
      { label: 'active', variant: 'success' },
      { label: 'No stake', variant: 'default' },
      { label: 'No stake', variant: 'default' },
    ])
    expect(out.map(d => d.powerUnknown)).toEqual([false, false, false])
  })

  it('fallback run: every newest row is 0, so those read their stored status and an unknown power', () => {
    const out = validatorDisplays([
      row(A, 'Figment', ZERO, 'active', RUN),
      row(B, 'Ankr', ZERO, 'inactive', RUN),
      row(C, 'Earlier', power, 'active', OLDER),   // an older row with real power keeps it
    ])
    expect(out.map(d => d.status.label)).toEqual(['active', 'inactive', 'active']) // not 'No stake' on all ~50
    expect(out[0]).toMatchObject({ powerUnknown: true, status: unknown('active') })
    expect(out[1]).toMatchObject({ powerUnknown: true, status: unknown('inactive') })
    expect(out[2]).toMatchObject({ powerUnknown: false, status: unknown('active') })
  })

  it('fallback run: an older zero row is still a stale "No stake", not part of the run', () => {
    const out = validatorDisplays([row(A, 'Figment', ZERO, 'active', RUN), row(B, 'Stale', ZERO, 'active', OLDER)])
    expect(out[0]).toMatchObject({ powerUnknown: true, status: unknown('active') })
    expect(out[1]).toMatchObject({ powerUnknown: false, status: { label: 'No stake', variant: 'default' } })
  })

  it('a jailed row keeps its status in a fallback run too', () => {
    expect(validatorDisplays([row(A, 'x', ZERO, 'jailed')])[0]).toMatchObject({ powerUnknown: true, status: { label: 'jailed', variant: 'fail' } })
  })

  it('a single-row table is its own newest run', () => {
    expect(validatorDisplays([row(A, 'Solo', ZERO)])[0]).toMatchObject({ powerUnknown: true, status: unknown('active') })
    expect(validatorDisplays([row(A, 'Solo', power)])[0]).toMatchObject({ powerUnknown: false, status: unknown('active') })
  })

  it('a zero row tied at the newest updatedAt with rows that have power is "No stake" (a normal run)', () => {
    const sameInstant = new Date(RUN.getTime()) // a different Date object for the same instant: compared by time
    const out = validatorDisplays([row(A, 'Figment', power, 'active', RUN), row(B, 'Squirrel', ZERO, 'active', sameInstant)])
    expect(out[1]).toMatchObject({ powerUnknown: false, status: { label: 'No stake', variant: 'default' } })
    expect(out[0]).toMatchObject({ powerUnknown: false, status: unknown('active') })
  })

  it('an empty table has nothing to show', () => {
    expect(validatorDisplays([])).toEqual([])
  })
})

// A validator in the stored set that produced no block in the last 24h, while the set as a whole did, is
// not "active" in any sense a reader can see: the 24h block counts decide, not the status the indexer
// always writes. "Standby" is the neutral reading; stronger facts (jailed, no stake) are never overwritten.
describe('validatorDisplays: Standby', () => {
  const STANDBY = { label: 'Standby', variant: 'default' }
  const counts = (entries: Record<string, number>) => new Map(Object.entries(entries))

  it('reads "Standby" with a neutral badge at 0 blocks in 24h while another validator produced blocks', () => {
    const out = validatorDisplays([row(A, 'Figment'), row(B, 'Idle')], counts({ [A]: 72 }))
    expect(out.map(d => d.status)).toEqual([{ label: 'active', variant: 'success' }, STANDBY])
  })

  it('a validator that produced even one block stays active', () => {
    expect(validatorDisplays([row(A, 'x'), row(B, 'y')], counts({ [A]: 72, [B]: 1 })).map(d => d.status.label)).toEqual(['active', 'active'])
  })

  it('matches the stored address to the miner counts case-insensitively', () => {
    const mixed = A.replace('75b851', '75B851')
    expect(validatorDisplays([row(mixed, 'Figment'), row(B, 'Idle')], counts({ [A]: 72 })).map(d => d.status.label)).toEqual(['active', 'Standby'])
  })

  it('does not infer Standby when the block counts are unavailable (null) or when the whole set produced none', () => {
    expect(validatorDisplays([row(A, 'x'), row(B, 'y')], null).map(d => d.status.label)).toEqual(['active', 'active'])
    expect(validatorDisplays([row(A, 'x'), row(B, 'y')]).map(d => d.status.label)).toEqual(['active', 'active'])
    expect(validatorDisplays([row(A, 'x'), row(B, 'y')], counts({})).map(d => d.status.label)).toEqual(['active', 'active'])
    // Miners that are not in the validator table do not make the set "producing".
    expect(validatorDisplays([row(A, 'x'), row(B, 'y')], counts({ [C]: 40 })).map(d => d.status.label)).toEqual(['active', 'active'])
  })

  it('keeps jailed and "No stake": both are stronger facts than being idle', () => {
    const out = validatorDisplays([row(A, 'Figment'), row(B, 'Jailed', '9', 'jailed'), row(C, 'Squirrel', '0')], counts({ [A]: 72 }))
    expect(out[1].status).toEqual({ label: 'jailed', variant: 'fail' })
    expect(out[2].status).toEqual({ label: 'No stake', variant: 'default' })
  })

  it('leaves any other stored status as stored', () => {
    expect(validatorDisplays([row(A, 'Figment'), row(B, 'x', '9', 'inactive')], counts({ [A]: 72 }))[1].status).toEqual({ label: 'inactive', variant: 'default' })
  })

  it('in a ValidatorSet fallback run (power unknown) an idle validator is still Standby, with its power still unknown', () => {
    const out = validatorDisplays([row(A, 'Figment', '0'), row(B, 'Idle', '0')], counts({ [A]: 72 }))
    expect(out.map(d => d.status.label)).toEqual(['active', 'Standby'])
    expect(out.map(d => d.powerUnknown)).toEqual([true, true])
  })
})
