/**
 * The /gas block tape as pure data: the newest blocks, width = transactions (as everywhere), fill = base fee.
 *
 * `blocks` has no gas-price column, so the base fee is the only per-block price the page can draw without a
 * second query over `transactions`. Where no block in view has a positive base fee (BNB Chain reports 0) the
 * fill is gas used instead, and every label says so: a fill that is not the measure its legend names would be
 * an invented number. The fill is the base fee as a share of the HIGHEST in view, so one block's fill can be
 * compared with another's; it is not a share of anything on chain.
 *
 * Rows are plain numbers (a BigInt voids a page-cache write, lib/page-cache.ts).
 */
import { formatGwei, formatNumber } from '@/lib/format'
import { gasPct, tapeWeight, type StripTile } from '@/lib/tape'

/** n = block number, txs = transaction count, used = gas used as a percent of the limit (0-100), fee = base fee in wei (null: none). */
export interface GasTapeRow { n: number; txs: number; used: number; fee: number | null }
export type GasBasis = 'base-fee' | 'gas-used'

export function rowFromBlock(b: {
  number: number
  txCount: number
  gasUsed: bigint | string | number | null
  gasLimit: bigint | string | number | null
  baseFeePerGas: string | null
}): GasTapeRow {
  const fee = b.baseFeePerGas === null ? null : Number(b.baseFeePerGas)
  return { n: b.number, txs: b.txCount, used: gasPct(b.gasUsed, b.gasLimit), fee: fee !== null && Number.isFinite(fee) ? fee : null }
}

/** The base fee when any block in view has a positive one, else gas used. */
export function gasBasis(rows: readonly GasTapeRow[]): GasBasis {
  return rows.some(r => r.fee !== null && r.fee > 0) ? 'base-fee' : 'gas-used'
}

/** Fill percent per row, in the order given. */
export function gasFills(rows: readonly GasTapeRow[], basis: GasBasis): number[] {
  if (basis === 'gas-used') return rows.map(r => r.used)
  const max = rows.reduce((m, r) => Math.max(m, r.fee ?? 0), 0)
  return rows.map(r => (max > 0 && r.fee !== null && r.fee > 0 ? Math.min(100, Math.round((100 * r.fee) / max)) : 0))
}

const gwei = (wei: number) => formatGwei(BigInt(Math.round(wei)))

/** One tile per block, oldest first (= left to right). `rows` come newest first, as the query returns them. */
export function gasStripTiles(rows: readonly GasTapeRow[], basis: GasBasis): StripTile[] {
  const fills = gasFills(rows, basis)
  return rows
    .map((r, i) => ({ r, f: fills[i] }))
    .sort((a, b) => a.r.n - b.r.n)
    .map(({ r, f }) => ({
      href: `/blocks/${r.n}`,
      w: tapeWeight(r.txs),
      f,
      name: `Block ${formatNumber(r.n)}`,
      // An unknown base fee (null) is not a zero one: it must never read "0 Gwei".
      read: `${r.txs} txns · ${basis === 'gas-used' ? `gas used ${r.used}%` : r.fee === null ? 'base fee unknown' : `base fee ${gwei(r.fee)} Gwei`}`,
    }))
}

/** The measure, said exactly; two lines at most on a phone (see test-support/legend-lines.ts). */
export function gasLegend(basis: GasBasis): string {
  return basis === 'base-fee'
    ? 'width = transactions · fill = base fee, % of the highest here · newest at right'
    : 'width = transactions · fill = gas used, % of limit · newest at right'
}

const newest = (rows: readonly GasTapeRow[]) => rows.reduce((m, r) => (r.n > m.n ? r : m), rows[0])

/** The band's head: the newest block, and what the fill is made of. */
export function gasStats(rows: readonly GasTapeRow[], basis: GasBasis): { main: string; side: string } {
  const fees = rows.flatMap(r => (r.fee !== null && r.fee > 0 ? [r.fee] : []))
  return {
    main: `latest #${formatNumber(newest(rows).n)}`,
    side: basis === 'base-fee'
      ? `base fee ${gwei(Math.min(...fees))}–${gwei(Math.max(...fees))} Gwei`
      : 'no base fee on this chain: fill is gas used',
  }
}

/** The strip's text alternative, from the same numbers the tiles carry. */
export function gasSummary(rows: readonly GasTapeRow[], basis: GasBasis): string {
  const n = rows.length
  if (basis === 'gas-used') {
    const used = rows.map(r => r.used)
    return `This chain has no base fee, so the fill is gas used: across the latest ${n} blocks it ran from ${Math.min(...used)}% to ${Math.max(...used)}% of the gas limit. `
      + 'Each tile is a block: width is its transactions.'
  }
  const fees = rows.flatMap(r => (r.fee !== null && r.fee > 0 ? [r.fee] : []))
  const latest = newest(rows)
  const newestFee = latest.fee === null ? 'has no base fee reading.' : `was ${gwei(latest.fee)} Gwei.`
  return `Base fee across the latest ${n} blocks ran from ${gwei(Math.min(...fees))} to ${gwei(Math.max(...fees))} Gwei; the newest, block ${formatNumber(latest.n)}, ${newestFee} `
    + 'Each tile is a block: width is its transactions, fill is its base fee as a share of the highest in view.'
}
