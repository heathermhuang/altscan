import { db, schema } from '@/lib/db'
import { eq, or, desc } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) return new Response('Rate limit exceeded', { status: 429 })

  const { address } = await params
  const addr = address.toLowerCase()

  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return new Response('Invalid address', { status: 400 })
  }

  let txs: typeof schema.transactions.$inferSelect[] = []
  try {
    txs = await db.select().from(schema.transactions)
      .where(or(eq(schema.transactions.fromAddress, addr), eq(schema.transactions.toAddress, addr)))
      .orderBy(desc(schema.transactions.timestamp))
      .limit(10000)
  } catch {
    return new Response('Database error', { status: 500 })
  }

  const header = 'Tx Hash,Block,Timestamp,From,To,Value (BNB),Gas Used,Gas Price (Gwei),Status,Method\n'
  const rows = txs.map(tx => {
    const intPart = (tx.value ?? '0').split('.')[0] || '0'
    const value = Number(BigInt(intPart)) / 1e18
    const gpPart = (tx.gasPrice?.toString() ?? '0').split('.')[0] || '0'
    const gwei = Number(BigInt(gpPart)) / 1e9
    return [
      tx.hash,
      tx.blockNumber,
      new Date(tx.timestamp).toISOString(),
      tx.fromAddress,
      tx.toAddress ?? '',
      value.toFixed(8),
      tx.gasUsed?.toString() ?? '0',
      gwei.toFixed(2),
      tx.status ? 'Success' : 'Failed',
      tx.methodId ?? '',
    ].join(',')
  }).join('\n')

  return new Response(header + rows, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="txs-${addr.slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
