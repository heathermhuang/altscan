import Link from 'next/link'
import { formatNativeToken, timeAgo, safeBigInt } from '@/lib/format'
import { shortHash } from '@/lib/address-display'
import { AddressLink } from '@/components/ui/AddressLink'
import { Badge } from '@/components/ui/Badge'
import { chainConfig } from '@/lib/chain'

interface TxRow {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string | null
  /**
   * null when the source cannot know it. A block fetched from RPC carries the
   * transaction bodies but not their receipts, so status is genuinely unknown
   * there — rendering "Success" for every row would be a fabrication.
   */
  status?: boolean | null
  gasUsed?: bigint | string | null
  timestamp: Date
}

export function TxTable({ txs, compact = false, showStatus = true }: {
  txs: TxRow[]
  compact?: boolean
  /** Hide the Status column entirely when no row can supply a real value. */
  showStatus?: boolean
}) {
  return (
    <div className="bg-card rounded-xl border border-hair overflow-hidden">
      <div className="overflow-x-auto">
      {/* `.dt-tx` (app/globals.css) turns each row into a three-line card under 640px from these same
          cells, so every column is in the DOM at every width; `compact` only drops To from 640px up. */}
      <table className={compact ? 'dt dt-tx dt-tx-c' : 'dt dt-tx'}>
        <caption className="sr-only">{chainConfig.name} transactions</caption>
        <thead className="max-sm:sr-only">
          <tr>
            <th scope="col">Tx Hash</th>
            <th scope="col">Age</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Value</th>
            {showStatus && <th scope="col">Status</th>}
          </tr>
        </thead>
        <tbody>
          {txs.map(tx => (
            <tr key={tx.hash}>
              <td>
                <Link href={`/tx/${tx.hash}`} className="text-acc-ink hover:underline">
                  {shortHash(tx.hash)}
                </Link>
              </td>
              <td className="text-mut">{timeAgo(new Date(tx.timestamp))}</td>
              <td>
                <AddressLink address={tx.fromAddress} title={false} />
              </td>
              <td>
                {tx.toAddress ? (
                  <AddressLink address={tx.toAddress} title={false} />
                ) : (
                  <span className="text-mut">Contract Creation</span>
                )}
              </td>
              <td>{formatNativeToken(safeBigInt(tx.value))} {chainConfig.currency}</td>
              {showStatus && (
                tx.status == null ? (
                  <td>
                    <span className="text-mut">—</span>
                  </td>
                ) : (
                  // tx-ok / tx-bad colour the phone status dot; the badge text stays as its label.
                  <td className={tx.status ? 'tx-ok' : 'tx-bad'}>
                    <Badge variant={tx.status ? 'success' : 'fail'}>
                      {tx.status ? 'Success' : 'Failed'}
                    </Badge>
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
