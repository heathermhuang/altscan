import Link from 'next/link'
import { formatETH, formatAddress, timeAgo, safeBigInt } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'

interface TxRow {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string | null
  status: boolean
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
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Tx Hash</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Age</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">From</th>
            {!compact && <th className="text-left px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">To</th>}
            <th className="text-left px-4 py-2 font-medium text-gray-500">Value</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {txs.map(tx => (
            <tr key={tx.hash} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-mono text-xs">
                <Link href={`/tx/${tx.hash}`} className="text-indigo-600 hover:underline">
                  {formatAddress(tx.hash, 10)}
                </Link>
              </td>
              <td className="px-4 py-2 text-gray-500 hidden sm:table-cell">{timeAgo(new Date(tx.timestamp))}</td>
              <td className="px-4 py-2 font-mono text-xs">
                <Link href={`/address/${tx.fromAddress}`} className="text-blue-600 hover:underline">
                  {formatAddress(tx.fromAddress)}
                </Link>
              </td>
              {!compact && (
                <td className="px-4 py-2 font-mono text-xs hidden sm:table-cell">
                  {tx.toAddress ? (
                    <Link href={`/address/${tx.toAddress}`} className="text-blue-600 hover:underline">
                      {formatAddress(tx.toAddress)}
                    </Link>
                  ) : (
                    <span className="text-gray-400">Contract Creation</span>
                  )}
                </td>
              )}
              <td className="px-4 py-2">{formatETH(safeBigInt(tx.value))} ETH</td>
              <td className="px-4 py-2">
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
