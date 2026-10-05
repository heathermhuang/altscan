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
      <table className="dt">
        <caption className="sr-only">{chainConfig.name} transactions</caption>
        <thead>
          <tr>
            <th scope="col">Tx Hash</th>
            <th scope="col" className="hidden sm:table-cell">Age</th>
            <th scope="col">From</th>
            {!compact && <th scope="col" className="hidden sm:table-cell">To</th>}
            <th scope="col">Value</th>
            {showStatus && <th scope="col" className="hidden sm:table-cell">Status</th>}
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
              <td className="text-mut hidden sm:table-cell">{timeAgo(new Date(tx.timestamp))}</td>
              <td>
                <AddressLink address={tx.fromAddress} />
              </td>
              {!compact && (
                <td className="hidden sm:table-cell">
                  {tx.toAddress ? (
                    <AddressLink address={tx.toAddress} />
                  ) : (
                    <span className="text-mut">Contract Creation</span>
                  )}
                </td>
              )}
              <td>{formatNativeToken(safeBigInt(tx.value))} {chainConfig.currency}</td>
              {showStatus && (
                <td className="hidden sm:table-cell">
                  {tx.status == null ? (
                    <span className="text-mut">—</span>
                  ) : (
                    <Badge variant={tx.status ? 'success' : 'fail'}>
                      {tx.status ? 'Success' : 'Failed'}
                    </Badge>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
