import { formatGwei, safeBigInt } from './format'

/**
 * /gas tiers: what transactions in the newest indexed blocks actually paid, not a price with a buffer on top.
 * Slow, Standard and Fast are the 25th, 50th and 75th percentile of the priority fee (tip) on an EIP-1559
 * chain, and of the gas price where there is no base fee (BNB). The percentiles are computed in SQL
 * (lib/gas-percentiles.ts), over the transactions of the newest GAS_TIER_BLOCKS blocks.
 */
export const GAS_TIER_BLOCKS = 20
/** Fewest transactions across that window that three percentiles can honestly be read from (one tx would be three copies of one price). */
export const GAS_TIER_MIN_TXS = 20

/** What the tier query returns: the counts it was computed over, the newest block's base fee, and the three percentile values (wei, numeric text). */
export type GasTierRow = {
  blocks: number
  txs: number
  baseFee: string | null
  tiers: readonly (string | null)[] | null
}

/** The tiers as they cross the page cache: wei as decimal strings (a bigint anywhere in a cached value voids Next's cache write). */
export type GasTiers = { slow: string; standard: string; fast: string; baseFee: string | null }

const WEI = /^\d+$/

/** The tiers, or null when the sample is too thin to honestly call them that (fewer blocks or transactions than asked for, a missing value). */
export function gasTiersFrom(row: GasTierRow | undefined): GasTiers | null {
  if (!row || row.blocks < GAS_TIER_BLOCKS || row.txs < GAS_TIER_MIN_TXS || !row.tiers || row.tiers.length !== 3) return null
  const [slow, standard, fast] = row.tiers
  if (slow == null || standard == null || fast == null || ![slow, standard, fast].every(v => WEI.test(v))) return null
  // BNB's blocks carry a base fee of 0 (or none): no base fee, so the percentiles are plain gas prices.
  const baseFee = row.baseFee != null && safeBigInt(row.baseFee) > 0n ? row.baseFee : null
  return { slow, standard, fast, baseFee }
}

export type GasTile = { label: 'Slow' | 'Standard' | 'Fast'; gwei: string; basis: string }

const TIERS = [['Slow', '25th', 'slow'], ['Standard', '50th', 'standard'], ['Fast', '75th', 'fast']] as const

/** The three tiles, in Gwei. With a base fee a tile is base + tip and says so; without data it is "—". */
export function gasTiles(tiers: GasTiers | null): GasTile[] {
  return TIERS.map(([label, pct, key]) => {
    if (!tiers) return { label, gwei: '—', basis: `${pct} percentile` }
    const price = safeBigInt(tiers[key])
    if (tiers.baseFee === null) return { label, gwei: formatGwei(price), basis: `${pct} percentile gas price` }
    const base = safeBigInt(tiers.baseFee)
    return { label, gwei: formatGwei(base + price), basis: `base ${formatGwei(base)} + tip ${formatGwei(price)}` }
  })
}

/**
 * The line under the tiles: what they are and which blocks they are from, also when there is nothing to show.
 * `failed` = the read itself failed; otherwise a null `tiers` is a sample too thin to call percentiles.
 */
export function gasTiersNote(tiers: GasTiers | null, eip1559: boolean, failed = false): string {
  const withBase = tiers ? tiers.baseFee !== null : eip1559
  const what = withBase
    ? `The newest block's base fee plus the priority fee (tip) paid by transactions from the last ${GAS_TIER_BLOCKS} blocks: Slow is the 25th percentile tip, Standard the 50th, Fast the 75th.`
    : `The gas price paid by transactions from the last ${GAS_TIER_BLOCKS} blocks: Slow is the 25th percentile, Standard the 50th, Fast the 75th. System transactions at a zero gas price are left out.`
  if (tiers) return what
  return `${failed ? 'Not available right now.' : 'Not enough recent transactions.'} ${what}`
}

/**
 * Which number the /gas headline card shows, and what it is honestly called.
 *
 * It is "Base Fee" only when the latest block carries a positive `baseFeePerGas`. BNB's is 0 and
 * a pre-1559 or unreadable block has none, so those fall back to the RPC gas price — labelled
 * "Gas Price", never "Base Fee", because `eth_gasPrice` includes the tip.
 */
export function feeCard(
  baseFeePerGas: bigint | null | undefined,
  gasPrice: bigint,
): { label: 'Base Fee' | 'Gas Price'; value: bigint } {
  return baseFeePerGas != null && baseFeePerGas > 0n
    ? { label: 'Base Fee', value: baseFeePerGas }
    : { label: 'Gas Price', value: gasPrice }
}
