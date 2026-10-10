import { describe, expect, it } from 'vitest'
import { validatorDisplays } from '@/lib/validator-display'
import { shortenAddress } from '@/lib/address-display'

const A = '0x75b851a27d7101438f45fce31816501193239a83'
const B = '0x37e9627a91dd13e453246856d58797ad6583d762'
const C = '0xd3b0d838ccceae7ebf1781d11d1bb741db7fe1a7'
const row = (address: string, moniker: string | null, votingPower = '5000000000000000000', status = 'active') =>
  ({ address, moniker, votingPower, status })

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
      expect(validatorDisplays([row(A, 'Squirrel', power)])[0].status).toEqual({ label: 'No stake', variant: 'default' })
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
