import { formatNativeToken, formatNumber, safeBigInt } from './format'

/**
 * The Analytics tab's "Sent" / "Received" figures are sums over a capped sample, the newest
 * FLOW_SAMPLE_CAP successful transactions the index holds, not lifetime totals: a full SUM over
 * `transactions` was the #1 cause of explorer OOMs, and retention keeps only a few days anyway.
 * These helpers say what the figure is, and refuse to print a number we do not have.
 */
export const FLOW_SAMPLE_CAP = 1000

export type FlowSample = { totalWei: string; count: number }

/**
 * One `SELECT SUM(value) AS total, COUNT(*) AS n` row as a sample. null when the row is missing or
 * malformed: a sum we could not read must not print as zero.
 */
export function parseFlowRow(row: unknown): FlowSample | null {
  if (typeof row !== 'object' || row === null) return null
  const { total, n } = row as Record<string, unknown>
  const count = Number(n)
  // numeric SUMs can carry a decimal tail ("1500000000000000000.000"); safeBigInt trims it.
  if (total == null || !/^\d+(\.\d*)?$/.test(String(total))) return null
  if (!Number.isInteger(count) || count < 0) return null
  return { totalWei: String(total), count }
}

/** "Sent (last 1,000 indexed transactions)" once the cap bit, else the count it actually summed. */
export function flowLabel(kind: 'Sent' | 'Received', sample: FlowSample | null, cap = FLOW_SAMPLE_CAP): string {
  if (!sample) return kind
  if (sample.count >= cap) return `${kind} (last ${formatNumber(cap)} indexed transactions)`
  return `${kind} (${formatNumber(sample.count)} indexed ${sample.count === 1 ? 'transaction' : 'transactions'})`
}

/** The sum with its unit, or "—" when the read failed. Never "0" for a figure we do not have. */
export function flowValue(sample: FlowSample | null, currency: string): string {
  return sample ? `${formatNativeToken(safeBigInt(sample.totalWei))} ${currency}` : '—'
}
