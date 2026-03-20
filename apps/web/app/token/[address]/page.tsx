import { db, schema } from '@/lib/db'
import { eq, desc } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatNumber } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import { Badge } from '@/components/ui/Badge'
import Link from 'next/link'

export default async function TokenDetailPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address } = await params
  const addr = address.toLowerCase()

  const [token] = await db.select().from(schema.tokens)
    .where(eq(schema.tokens.address, addr))

  if (!token) notFound()

  const transfers = await db.select().from(schema.tokenTransfers)
    .where(eq(schema.tokenTransfers.tokenAddress, addr))
    .orderBy(desc(schema.tokenTransfers.blockNumber))
    .limit(25)

  const displaySupply = (() => {
    try {
      return formatNumber(Number(BigInt(token.totalSupply) / 10n ** BigInt(token.decimals)))
    } catch {
      return token.totalSupply.slice(0, 20)
    }
  })()

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">{token.name}</h1>
        <Badge variant="default">{token.symbol}</Badge>
        <Badge variant="default">{token.type}</Badge>
      </div>

      <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Contract</p>
            <p className="font-mono text-xs">{addr.slice(0, 14)}…<CopyButton text={addr} /></p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Decimals</p>
            <p className="font-semibold">{token.decimals}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Total Supply</p>
            <p className="font-semibold">{displaySupply}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Holders</p>
            <p className="font-semibold">{formatNumber(token.holderCount)}</p>
          </div>
        </div>
      </div>

      <h2 className="font-semibold mb-4">Token Transfers</h2>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 text-gray-500">Block</th>
              <th className="text-left px-4 py-2 text-gray-500">From</th>
              <th className="text-left px-4 py-2 text-gray-500">To</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {transfers.map((t, i) => {
              const amount = (() => {
                try { return (Number(BigInt(t.value)) / 10 ** token.decimals).toFixed(4) }
                catch { return t.value.slice(0, 10) }
              })()
              return (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${t.txHash}`} className="text-yellow-600 hover:underline">
                      {t.txHash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{t.blockNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${t.fromAddress}`} className="text-blue-600 hover:underline">
                      {t.fromAddress.slice(0, 12)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${t.toAddress}`} className="text-blue-600 hover:underline">
                      {t.toAddress.slice(0, 12)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2">{amount} {token.symbol}</td>
                </tr>
              )
            })}
            {transfers.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No transfers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
