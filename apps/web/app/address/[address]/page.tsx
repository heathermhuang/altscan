import { db, schema } from '@/lib/db'
import { eq, or } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatBNB, formatNumber, timeAgo } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import Link from 'next/link'

export default async function AddressPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address } = await params
  const addr = address.toLowerCase()

  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) notFound()

  const [addressInfo, txs, contractResult] = await Promise.all([
    db.select().from(schema.addresses)
      .where(eq(schema.addresses.address, addr))
      .limit(1)
      .then(r => r[0] ?? null),
    db.select().from(schema.transactions)
      .where(or(
        eq(schema.transactions.fromAddress, addr),
        eq(schema.transactions.toAddress, addr),
      ))
      .limit(25),
    db.select().from(schema.contracts)
      .where(eq(schema.contracts.address, addr))
      .limit(1)
      .then(r => r[0] ?? null),
  ])

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Address</h1>
        {addressInfo?.isContract && <Badge variant="default">Contract</Badge>}
        {addressInfo?.label && <Badge variant="default">{addressInfo.label}</Badge>}
      </div>

      {/* Address + stats */}
      <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
        <div className="font-mono text-sm break-all text-gray-800">
          {addr}
          <CopyButton text={addr} />
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <StatItem
            label="BNB Balance"
            value={`${formatBNB(BigInt(addressInfo?.balance ?? '0'))} BNB`}
          />
          <StatItem
            label="Transactions"
            value={formatNumber(addressInfo?.txCount ?? 0)}
          />
          <StatItem
            label="First Seen"
            value={addressInfo?.firstSeen
              ? timeAgo(new Date(addressInfo.firstSeen))
              : 'Unknown'}
          />
        </div>
      </div>

      {/* Contract section */}
      {addressInfo?.isContract && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <h2 className="font-semibold mb-3">Contract</h2>
          {contractResult?.verifiedAt ? (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="success">Verified</Badge>
                <span className="text-sm text-gray-500">
                  via {contractResult.verifySource} • {contractResult.compilerVersion ?? 'unknown'}
                </span>
              </div>
              {contractResult.license && (
                <p className="text-sm text-gray-500 mb-2">License: {contractResult.license}</p>
              )}
              {contractResult.sourceCode && (
                <pre className="mt-3 bg-gray-50 p-3 rounded text-xs overflow-auto max-h-64 border">
                  {contractResult.sourceCode.slice(0, 2000)}
                  {contractResult.sourceCode.length > 2000 ? '\n// ... truncated' : ''}
                </pre>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Badge variant="pending">Unverified</Badge>
              <Link href="/verify" className="text-sm text-yellow-600 hover:underline">
                Verify this contract →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Transactions */}
      <h2 className="font-semibold mb-4">
        Transactions {txs.length === 25 ? '(showing latest 25)' : `(${txs.length})`}
      </h2>
      {txs.length > 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Tx Hash</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Age</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">From / To</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {txs.map(tx => (
                <tr key={tx.hash} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${tx.hash}`} className="text-yellow-600 hover:underline">
                      {tx.hash.slice(0, 14)}...
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {timeAgo(new Date(tx.timestamp))}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <div>
                      <span className="text-gray-400 text-xs">
                        {tx.fromAddress.toLowerCase() === addr ? 'OUT' : 'IN'}{' '}
                      </span>
                      <Link
                        href={`/address/${tx.fromAddress.toLowerCase() === addr ? tx.toAddress ?? addr : tx.fromAddress}`}
                        className="text-blue-600 hover:underline"
                      >
                        {(tx.fromAddress.toLowerCase() === addr
                          ? tx.toAddress ?? 'Contract Creation'
                          : tx.fromAddress
                        ).slice(0, 12)}...
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {formatBNB(BigInt(tx.value ?? '0'))} BNB
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-gray-500">No transactions found for this address.</p>
      )}
    </div>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-gray-500 text-xs mb-0.5">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  )
}
