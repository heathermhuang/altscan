import { formatNumber } from './format'

export type TxCountDisplay = {
  /** What to paginate and list against: the index's count, never the RPC nonce. */
  total: number
  /** false = the index cannot vouch for a count, so no page text may print one. */
  known: boolean
  /** `total` formatted, or "—" when it is not known. */
  text: string
  /** The on-chain nonce labelled as what it is, shown only while `known` is false. */
  nonceNote: string | null
}

/**
 * The wallet's transaction count for display.
 *
 * `indexed` is addresses.tx_count (null: no row, or the read failed). `nonce` is the RPC
 * transaction count, which counts only the address's OUTGOING transactions: it is a lower bound
 * on the total, not the total, so it is never summed in or substituted. It is also unusable for
 * a contract (it counts contracts created).
 *
 * An indexed 0 beside a non-zero nonce is a contradiction (the chain shows sends the index has
 * not seen), so it is "unknown" like a missing row rather than a confident "0 transactions".
 */
export function resolveTxCount({ indexed, nonce }: { indexed: number | null | undefined; nonce: number | null | undefined }): TxCountDisplay {
  const total = indexed ?? 0
  const sent = nonce && nonce > 0 ? nonce : 0
  const known = indexed != null && !(indexed === 0 && sent > 0)
  return {
    total,
    known,
    text: known ? formatNumber(total) : '—',
    nonceNote: !known && sent > 0 ? `${formatNumber(sent)} sent (nonce)` : null,
  }
}
