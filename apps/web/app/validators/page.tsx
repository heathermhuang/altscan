import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { formatNumber } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import Link from 'next/link'

export const revalidate = 120

export default async function ValidatorsPage() {
  let validators: typeof schema.validators.$inferSelect[] = []
  try {
    validators = await db.select().from(schema.validators)
      .orderBy(desc(schema.validators.votingPower))
      .limit(100)
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">
        BNB Chain Validators{validators.length > 0 ? ` (${validators.length})` : ''}
      </h1>

      {validators.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <p className="text-gray-400 text-lg mb-2">No validators synced yet</p>
          <p className="text-gray-300 text-sm">
            Validator data will appear here once the indexer has synced BNB Chain validator information.
          </p>
        </div>
      ) : (
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">#</th>
              <th className="text-left px-4 py-2 text-gray-500">Validator</th>
              <th className="text-left px-4 py-2 text-gray-500">Status</th>
              <th className="text-left px-4 py-2 text-gray-500">Voting Power</th>
              <th className="text-left px-4 py-2 text-gray-500">Commission</th>
              <th className="text-left px-4 py-2 text-gray-500">Uptime</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {validators.map((v, i) => (
              <tr key={v.address} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                <td className="px-4 py-2">
                  <Link href={`/address/${v.address}`} className="text-yellow-600 hover:underline font-medium">
                    {v.moniker}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <Badge variant={
                    v.status === 'active'   ? 'success' :
                    v.status === 'jailed'   ? 'fail'    : 'default'
                  }>
                    {v.status}
                  </Badge>
                </td>
                <td className="px-4 py-2">{formatNumber(parseFloat(v.votingPower ?? '0'))}</td>
                <td className="px-4 py-2">{(parseFloat(v.commission ?? '0') * 100).toFixed(1)}%</td>
                <td className="px-4 py-2">{(parseFloat(v.uptime ?? '0') * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}
