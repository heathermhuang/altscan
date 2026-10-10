/**
 * What the validators table shows for a row, decided in one place.
 *
 * The indexer writes `Validator ${rank}` when it cannot resolve a moniker, and always writes
 * status 'active' (apps/indexer/src/validator-syncer.ts), so the table showed rank-derived
 * placeholders as names and a stake-less validator as ACTIVE. The indexer is left alone: both
 * are corrected here, at the render boundary.
 */
import { shortenAddress } from './address-display'
import { safeBigInt } from './format'

export type ValidatorRow = {
  address: string
  moniker: string | null
  votingPower: string | null
  status: string
}

export type ValidatorDisplay = {
  name: string
  status: { label: string; variant: 'success' | 'fail' | 'default' }
}

const PLACEHOLDER_MONIKER = /^Validator \d+$/

function statusOf(v: ValidatorRow): ValidatorDisplay['status'] {
  // Jailed is a stronger fact than "no stake", so it is never overwritten.
  if (v.status === 'jailed') return { label: 'jailed', variant: 'fail' }
  if (safeBigInt(v.votingPower) === 0n) return { label: 'No stake', variant: 'default' }
  return { label: v.status, variant: v.status === 'active' ? 'success' : 'default' }
}

export function validatorDisplays(rows: readonly ValidatorRow[]): ValidatorDisplay[] {
  const named = rows.map(v => {
    const moniker = (v.moniker ?? '').trim()
    const placeholder = moniker === '' || PLACEHOLDER_MONIKER.test(moniker)
    return { name: placeholder ? shortenAddress(v.address) : moniker, placeholder }
  })

  // Counted after the placeholder substitution. A stand-in already is the short address, so it never
  // gets a second one appended.
  const seen = new Map<string, number>()
  for (const { name } of named) {
    const key = name.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  return rows.map((v, i) => {
    const { name, placeholder } = named[i]
    const duplicated = !placeholder && (seen.get(name.toLowerCase()) ?? 0) > 1
    return {
      name: duplicated ? `${name} ${shortenAddress(v.address)}` : name,
      status: statusOf(v),
    }
  })
}
