import { db, schema } from '@/lib/db'
import { eq, desc, count, sql } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatNumber, formatAddress } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import { Badge } from '@/components/ui/Badge'
import { Pagination } from '@/components/ui/Pagination'
import Link from 'next/link'
import type { Metadata } from 'next'

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params
  let token: typeof schema.tokens.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.tokens).where(eq(schema.tokens.address, address.toLowerCase())).limit(1)
    token = row ?? null
  } catch { /* DB error */ }
  if (!token) return { title: 'Token Not Found — BNBScan' }
  return {
    title: `${token.name} (${token.symbol}) — BNBScan`,
    description: `${token.name} (${token.symbol}) ${token.type} token on BNB Chain. ${token.holderCount.toLocaleString()} holders.`,
    openGraph: {
      title: `${token.name} (${token.symbol})`,
      description: `${token.type} · ${token.holderCount.toLocaleString()} holders`,
    },
  }
}

export const revalidate = 60

const PAGE_SIZE = 25

type HolderRow = { addr: string; balance: string }

async function fetchTopHolders(tokenAddr: string): Promise<HolderRow[]> {
  try {
    const result = await db.execute(sql`
      WITH inflows AS (
        SELECT to_address as addr, SUM(value::numeric) as total
        FROM token_transfers WHERE token_address = ${tokenAddr} GROUP BY 1
      ),
      outflows AS (
        SELECT from_address as addr, SUM(value::numeric) as total
        FROM token_transfers WHERE token_address = ${tokenAddr} GROUP BY 1
      )
      SELECT i.addr, (COALESCE(i.total, 0) - COALESCE(o.total, 0))::text as balance
      FROM inflows i
      LEFT JOIN outflows o ON i.addr = o.addr
      WHERE (COALESCE(i.total, 0) - COALESCE(o.total, 0)) > 0
      ORDER BY balance DESC
      LIMIT 10
    `)
    return Array.from(result).map((row) => ({
      addr: String((row as Record<string, unknown>).addr),
      balance: String((row as Record<string, unknown>).balance),
    }))
  } catch {
    return []
  }
}

export default async function TokenDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { address } = await params
  const { page: pageStr } = await searchParams
  const addr = address.toLowerCase()
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  const [token] = await db
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.address, addr))

  if (!token) notFound()

  const [transfers, [{ value: totalTransfers }], topHolders] = await Promise.all([
    db
      .select()
      .from(schema.tokenTransfers)
      .where(eq(schema.tokenTransfers.tokenAddress, addr))
      .orderBy(desc(schema.tokenTransfers.blockNumber))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({ value: count() })
      .from(schema.tokenTransfers)
      .where(eq(schema.tokenTransfers.tokenAddress, addr)),
    fetchTopHolders(addr),
  ])

  const displaySupply = (() => {
    try {
      const divisor = 10n ** BigInt(token.decimals)
      const whole = BigInt(token.totalSupply ?? '0') / divisor
      return whole.toLocaleString()
    } catch {
      return (token.totalSupply ?? '0').slice(0, 20)
    }
  })()

  // Compute total supply as BigInt for percentage calculation
  const totalSupplyBig = (() => {
    try {
      return BigInt(token.totalSupply ?? '0')
    } catch {
      return 0n
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
            <p className="font-mono text-xs">
              {addr.slice(0, 14)}…<CopyButton text={addr} />
            </p>
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

      {/* Top Holders */}
      {topHolders.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h2 className="font-semibold">Top Holders</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-gray-500 w-10">#</th>
                <th className="text-left px-4 py-2 text-gray-500">Address</th>
                <th className="text-left px-4 py-2 text-gray-500">
                  Approx. Balance
                </th>
                <th className="text-left px-4 py-2 text-gray-500">
                  % of Supply
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {topHolders.map((holder, i) => {
                const holderAmount = (() => {
                  try {
                    const divisor = 10n ** BigInt(token.decimals)
                    const whole = BigInt(holder.balance) / divisor
                    return whole.toLocaleString()
                  } catch {
                    return holder.balance.slice(0, 12)
                  }
                })()
                const pct = (() => {
                  try {
                    if (totalSupplyBig === 0n) return '—'
                    const bal = BigInt(holder.balance)
                    // Use integer math, scale by 10000 for 2 decimal places
                    const scaled = (bal * 10000n) / totalSupplyBig
                    return `${(Number(scaled) / 100).toFixed(2)}%`
                  } catch {
                    return '—'
                  }
                })()
                return (
                  <tr key={holder.addr} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link
                        href={`/address/${holder.addr}`}
                        className="text-blue-600 hover:underline"
                      >
                        {holder.addr}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      {holderAmount} {token.symbol}
                    </td>
                    <td className="px-4 py-2 text-gray-600">{pct}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Token Transfers */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">
          Token Transfers{' '}
          <span className="text-gray-400 font-normal text-sm">
            ({formatNumber(totalTransfers)} total)
          </span>
        </h2>
      </div>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-4">
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
            {transfers.map((t) => {
              const amount = (() => {
                try {
                  const divisor = 10n ** BigInt(token.decimals)
                  const whole = BigInt(t.value ?? '0') / divisor
                  const frac = BigInt(t.value ?? '0') % divisor
                  const fracStr = frac
                    .toString()
                    .padStart(token.decimals, '0')
                    .slice(0, 4)
                    .replace(/0+$/, '')
                  return fracStr
                    ? `${whole.toLocaleString()}.${fracStr}`
                    : whole.toLocaleString()
                } catch {
                  return (t.value ?? '0').slice(0, 10)
                }
              })()
              return (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link
                      href={`/tx/${t.txHash}`}
                      className="text-yellow-600 hover:underline"
                    >
                      {t.txHash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{t.blockNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link
                      href={`/address/${t.fromAddress}`}
                      className="text-blue-600 hover:underline"
                    >
                      {formatAddress(t.fromAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link
                      href={`/address/${t.toAddress}`}
                      className="text-blue-600 hover:underline"
                    >
                      {formatAddress(t.toAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {amount} {token.symbol}
                  </td>
                </tr>
              )
            })}
            {transfers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No transfers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        total={totalTransfers}
        perPage={PAGE_SIZE}
        baseUrl={`/token/${addr}`}
      />
    </div>
  )
}
