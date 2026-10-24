/**
 * Token amounts whose scale may be unknown. A token's decimals() is read from the node (or the index's metadata row), and a
 * read that fails is UNKNOWN, not 18: scaling by a guessed 18 prints a 6-decimals token (ETH USDT, USDC) a trillion times too
 * small, and its supply as "0". These helpers keep "unknown" as null until the cell that prints it.
 */
import { formatAmountCompact, hasSupply, safeBigInt } from './format'

/** A decimals() reading: the integer if the call answered one (uint8), else null. Failed reads and nonsense are unknown. */
export function readDecimals(value: unknown): number | null {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null
}

/** The Total Supply cell: the whole-token supply, "—" when there is none, the raw units (labelled) when the decimals are unknown. */
export function supplyText(totalSupply: string | null | undefined, decimals: number | null): string {
  if (!hasSupply(totalSupply)) return '—'
  if (decimals === null) return `${safeBigInt(totalSupply).toLocaleString('en-US')} raw units`
  try {
    return (BigInt(totalSupply ?? '0') / 10n ** BigInt(decimals)).toLocaleString()
  } catch {
    return (totalSupply ?? '0').slice(0, 20)
  }
}

/** One leg of a swap: the compact amount, or "—" when the token's decimals are unknown (the leg is not scaled by a guess). */
export function legAmount(raw: string | bigint, decimals: number | null | undefined): string {
  return decimals == null ? '—' : formatAmountCompact(raw, decimals)
}
