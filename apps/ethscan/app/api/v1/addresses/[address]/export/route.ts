import { db, schema } from '@/lib/db'
import { eq, or, desc } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { safeBigInt } from '@/lib/format'

/**
 * Sanitize a CSV field to prevent formula injection.
 * Excel/Sheets interpret cells starting with =, +, -, @, \t, \r as formulas.
 */
function csvSafe(value: string): string {
  const s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) {
    return `"'${s.replace(/"/g, '""')}"`
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

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

  const header = 'Tx Hash,Block,Timestamp,From,To,Value (ETH),Gas Used,Gas Price (Gwei),Status,Method\n'
  const rows = txs.map(tx => {
    const value = Number(safeBigInt(tx.value)) / 1e18
    const gwei = Number(BigInt(tx.gasPrice ?? '0')) / 1e9
    return [
      csvSafe(tx.hash),
      tx.blockNumber,
      new Date(tx.timestamp).toISOString(),
      csvSafe(tx.fromAddress),
      csvSafe(tx.toAddress ?? ''),
      value.toFixed(8),
      tx.gasUsed?.toString() ?? '0',
      gwei.toFixed(2),
      tx.status ? 'Success' : 'Failed',
      csvSafe(tx.methodId ?? ''),
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
