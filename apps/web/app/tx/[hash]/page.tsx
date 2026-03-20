import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatBNB, formatGwei, formatNumber, timeAgo } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import Link from 'next/link'

export default async function TxDetailPage({
  params,
}: {
  params: Promise<{ hash: string }>
}) {
  const { hash } = await params

  const [tx] = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.hash, hash))

  if (!tx) notFound()

  const [txLogs, transfers] = await Promise.all([
    db.select().from(schema.logs)
      .where(eq(schema.logs.txHash, hash))
      .limit(50),
    db.select().from(schema.tokenTransfers)
      .where(eq(schema.tokenTransfers.txHash, hash))
      .limit(25),
  ])

  const fee = BigInt(tx.gasUsed ?? 0) * BigInt(tx.gasPrice ?? 0)

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Transaction Details</h1>
        <Badge variant={tx.status ? 'success' : 'fail'}>
          {tx.status ? 'Success' : 'Failed'}
        </Badge>
      </div>

      <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y">
            <Row label="Transaction Hash" value={tx.hash} mono copy />
            <Row label="Status" value={tx.status ? 'Success' : 'Failed'} />
            <Row
              label="Block"
              value={String(tx.blockNumber)}
              link={`/blocks/${tx.blockNumber}`}
            />
            <Row
              label="Timestamp"
              value={`${timeAgo(new Date(tx.timestamp))} (${new Date(tx.timestamp).toUTCString()})`}
            />
            <Row
              label="From"
              value={tx.fromAddress}
              mono
              copy
              link={`/address/${tx.fromAddress}`}
            />
            <Row
              label="To"
              value={tx.toAddress ?? 'Contract Creation'}
              mono
              copy={!!tx.toAddress}
              link={tx.toAddress ? `/address/${tx.toAddress}` : undefined}
            />
            <Row
              label="Value"
              value={`${formatBNB(BigInt((tx.value ?? '0').split('.')[0]))} BNB`}
            />
            <Row
              label="Transaction Fee"
              value={`${formatBNB(fee)} BNB`}
            />
            <Row
              label="Gas Price"
              value={`${formatGwei(BigInt(tx.gasPrice ?? 0))} Gwei`}
            />
            <Row
              label="Gas Used / Limit"
              value={`${formatNumber(Number(tx.gasUsed ?? 0))} / ${formatNumber(Number(tx.gas ?? 0))}`}
            />
            {tx.methodId && (
              <Row label="Method ID" value={tx.methodId} mono />
            )}
          </tbody>
        </table>
      </div>

      {transfers.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <h2 className="font-semibold mb-3">Token Transfers ({transfers.length})</h2>
          <div className="space-y-2">
            {transfers.map((t, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-500">From</span>
                <Link
                  href={`/address/${t.fromAddress}`}
                  className="text-blue-600 font-mono text-xs hover:underline"
                >
                  {t.fromAddress.slice(0, 12)}...
                </Link>
                <span className="text-gray-500">To</span>
                <Link
                  href={`/address/${t.toAddress}`}
                  className="text-blue-600 font-mono text-xs hover:underline"
                >
                  {t.toAddress.slice(0, 12)}...
                </Link>
                <span className="text-gray-500">Token</span>
                <Link
                  href={`/token/${t.tokenAddress}`}
                  className="text-yellow-600 hover:underline"
                >
                  {t.tokenAddress.slice(0, 12)}...
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {txLogs.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <h2 className="font-semibold mb-3">Event Logs ({txLogs.length})</h2>
          <div className="space-y-3">
            {txLogs.map((log, i) => (
              <div key={i} className="bg-gray-50 rounded p-3 font-mono text-xs overflow-auto">
                <div>
                  <span className="text-gray-500">Address: </span>
                  <Link href={`/address/${log.address}`} className="text-blue-600 hover:underline">
                    {log.address}
                  </Link>
                </div>
                {log.topic0 && (
                  <div><span className="text-gray-500">Topic0: </span>{log.topic0}</div>
                )}
                {log.topic1 && (
                  <div><span className="text-gray-500">Topic1: </span>{log.topic1}</div>
                )}
                <div>
                  <span className="text-gray-500">Data: </span>
                  {log.data.slice(0, 130)}
                  {log.data.length > 130 ? '…' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  mono = false,
  copy = false,
  link,
}: {
  label: string
  value: string
  mono?: boolean
  copy?: boolean
  link?: string
}) {
  return (
    <tr>
      <td className="px-6 py-3 text-gray-500 w-44 font-medium shrink-0">{label}</td>
      <td className={`px-6 py-3 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {link ? (
          <Link href={link} className="text-blue-600 hover:underline">{value}</Link>
        ) : (
          value
        )}
        {copy && <CopyButton text={value} />}
      </td>
    </tr>
  )
}
