/**
 * What the validators table shows for a row, decided in one place.
 *
 * The indexer writes `Validator ${rank}` when it cannot resolve a moniker, and always writes
 * status 'active' (apps/indexer/src/validator-syncer.ts), so the table showed rank-derived
 * placeholders as names and a stake-less validator as ACTIVE. The indexer is left alone: both
 * are corrected here, at the render boundary.
 */
import { shortenAddress } from '@/lib/address-display'
import { safeBigInt } from '@/lib/format'
import { blocksProduced } from '@/lib/validator-blocks'

export type ValidatorRow = {
  address: string
  moniker: string | null
  votingPower: string | null
  status: string
  updatedAt: Date
}

export type ValidatorDisplay = {
  name: string
  status: { label: string; variant: 'success' | 'fail' | 'default' }
  /** The stored voting power is a placeholder 0 from the ValidatorSet fallback: show no number. */
  powerUnknown: boolean
}

const PLACEHOLDER_MONIKER = /^Validator \d+$/

const noPower = (v: ValidatorRow) => safeBigInt(v.votingPower) === 0n

function statusOf(v: ValidatorRow, powerUnknown: boolean, idle: boolean): ValidatorDisplay['status'] {
  // Jailed is a stronger fact than "no stake", so it is never overwritten.
  if (v.status === 'jailed') return { label: 'jailed', variant: 'fail' }
  if (noPower(v) && !powerUnknown) return { label: 'No stake', variant: 'default' }
  // The indexer stores 'active' for the whole set, so the stored word proves nothing about the last 24h.
  if (idle && v.status === 'active') return { label: 'Standby', variant: 'default' }
  return { label: v.status, variant: v.status === 'active' ? 'success' : 'default' }
}

/**
 * `blocks24h` is the page's miner counts (lib/validator-blocks), or null when that query failed. A
 * validator is idle only when its own count is 0 AND some validator in this table produced blocks: with
 * no counts, or none from anyone, the window says nothing, so Standby is never inferred from it.
 */
export function validatorDisplays(
  rows: readonly ValidatorRow[],
  blocks24h: ReadonlyMap<string, number> | null = null,
): ValidatorDisplay[] {
  const setProduced = rows.some(v => (blocksProduced(blocks24h, v.address) ?? 0) > 0)
  const idle = (v: ValidatorRow) => setProduced && blocksProduced(blocks24h, v.address) === 0

  // When StakeHub fails, the syncer falls back to the ValidatorSet contract (validator-syncer.ts) and
  // upserts the whole set with voting power 0 in a single run, so all of those rows share one
  // updatedAt. If every row from the newest run is 0, that is a fallback run: their power is unknown,
  // not "No stake". A 0 row from an older run, or beside rows with power, is a real stake-less one.
  const newest = rows.reduce((max, v) => Math.max(max, v.updatedAt.getTime()), -Infinity)
  const newestRun = rows.filter(v => v.updatedAt.getTime() === newest)
  const fallbackRun = newestRun.length > 0 && newestRun.every(noPower)
  const powerUnknown = (v: ValidatorRow) => fallbackRun && noPower(v) && v.updatedAt.getTime() === newest

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
      status: statusOf(v, powerUnknown(v), idle(v)),
      powerUnknown: powerUnknown(v),
    }
  })
}
