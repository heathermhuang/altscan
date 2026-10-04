import Link from 'next/link'
import { formatNativeToken, formatAddress, timeAgo, safeBigInt } from '@/lib/format'
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
      <table className="w-full text-sm">
        <caption className="sr-only">{chainConfig.name} transactions</caption>
        <thead className="bg-canvas border-b border-hair">
          <tr>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Tx Hash</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">Age</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">From</th>
            {!compact && <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">To</th>}
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Value</th>
            {showStatus && <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">Status</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {txs.map(tx => (
            <tr key={tx.hash} className="hover:bg-canvas transition-colors">
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
                <Link href={`/tx/${tx.hash}`} className="text-acc-ink hover:underline">
                  {formatAddress(tx.hash, 10)}
                </Link>
              </td>
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-mut hidden sm:table-cell">{timeAgo(new Date(tx.timestamp))}</td>
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
                <AddressLink address={tx.fromAddress} />
              </td>
              {!compact && (
                <td className="px-3 sm:px-4 py-2 font-mono text-[13px] hidden sm:table-cell">
                  {tx.toAddress ? (
                    <AddressLink address={tx.toAddress} />
                  ) : (
                    <span className="text-mut">Contract Creation</span>
                  )}
                </td>
              )}
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">{formatNativeToken(safeBigInt(tx.value))} {chainConfig.currency}</td>
              {showStatus && (
                <td className="px-3 sm:px-4 py-2 hidden sm:table-cell">
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
