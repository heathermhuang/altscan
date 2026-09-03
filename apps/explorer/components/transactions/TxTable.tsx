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
  status: boolean
  gasUsed: bigint | string | null
  timestamp: Date
}

export function TxTable({ txs, compact = false }: {
  txs: TxRow[]
  compact?: boolean
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{chainConfig.name} transactions</caption>
        <thead className="bg-gray-50 border-b">
          <tr>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Tx Hash</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Age</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">From</th>
            {!compact && <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">To</th>}
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Value</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {txs.map(tx => (
            <tr key={tx.hash} className="hover:bg-gray-50/80 transition-colors">
              <td className="px-3 sm:px-4 py-2 font-mono text-xs">
                <Link href={`/tx/${tx.hash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                  {formatAddress(tx.hash, 10)}
                </Link>
              </td>
              <td className="px-3 sm:px-4 py-2 text-gray-500 hidden sm:table-cell">{timeAgo(new Date(tx.timestamp))}</td>
              <td className="px-3 sm:px-4 py-2 font-mono text-xs">
                <AddressLink address={tx.fromAddress} />
              </td>
              {!compact && (
                <td className="px-3 sm:px-4 py-2 font-mono text-xs hidden sm:table-cell">
                  {tx.toAddress ? (
                    <AddressLink address={tx.toAddress} />
                  ) : (
                    <span className="text-gray-400">Contract Creation</span>
                  )}
                </td>
              )}
              <td className="px-3 sm:px-4 py-2">{formatNativeToken(safeBigInt(tx.value))} {chainConfig.currency}</td>
              <td className="px-3 sm:px-4 py-2 hidden sm:table-cell">
                <Badge variant={tx.status ? 'success' : 'fail'}>
                  {tx.status ? 'Success' : 'Failed'}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
