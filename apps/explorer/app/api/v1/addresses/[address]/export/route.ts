import { db, schema } from '@/lib/db'
import { selectByAddress } from '@/lib/address-query'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { chainConfig } from '@/lib/chain'
import { readCoverage } from '@/lib/address-coverage'

export const dynamic = 'force-dynamic'

const EXPORT_LIMIT = 1000

/**
 * Sanitize a CSV field to prevent formula injection.
 * Excel/Sheets interpret cells starting with =, +, -, @, \t, \r as formulas.
 * Prefix with a single quote to force text mode, and wrap in double quotes.
 */
function csvSafe(value: string): string {
  const s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) {
    return `"'${s.replace(/"/g, '""')}"`
  }
  // Wrap in quotes if contains comma, quote, or newline
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  if (!(await checkIpRateLimit(request.headers))) return new Response('Rate limit exceeded', { status: 429 })

  const { address } = await params
  const addr = address.toLowerCase()

  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return new Response('Invalid address', { status: 400 })
  }

  // Alongside the query; it cannot reject (a failure degrades to unknown). Same answer as the JSON route.
  const coverage = readCoverage(addr)

  let txs: typeof schema.transactions.$inferSelect[] = []
  try {
    // selectByAddress, not `from = a OR to = a`: no index serves that filter in this order, so for
    // a busy address the OR form read far more than these 1,000 rows, which is why the JSON route
    // and the address page stopped running it. Same order as the address page's transactions tab,
    // tx_index breaking ties within a block.
    txs = await selectByAddress(db, schema.transactions, addr, [], {
      order: 'desc', limit: EXPORT_LIMIT, offset: 0, tieBreak: schema.transactions.txIndex,
    }) as typeof txs
  } catch {
    return new Response('Database error', { status: 500 })
  }

  const header = `Tx Hash,Block,Timestamp,From,To,Value (${chainConfig.currency}),Gas Used,Gas Price (Gwei),Status,Method\n`
  const rows = txs.map(tx => {
    const intPart = (tx.value ?? '0').split('.')[0] || '0'
    const value = Number(BigInt(intPart)) / 1e18
    const gpPart = (tx.gasPrice?.toString() ?? '0').split('.')[0] || '0'
    const gwei = Number(BigInt(gpPart)) / 1e9
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

  // The body is just rows, so a script cannot tell a wallet's whole history from the slice the index
  // still holds. These say which it got. Complete is omitted when unknown (no index row, no retention
  // floor), as the JSON route reports null.
  const { historyComplete, indexedFrom } = await coverage
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="txs-${addr.slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store',
  }
  if (historyComplete !== null) headers['X-History-Complete'] = String(historyComplete)
  if (indexedFrom) headers['X-Indexed-From'] = indexedFrom.toISOString()
  if (txs.length >= EXPORT_LIMIT) headers['X-History-Truncated'] = 'true'

  return new Response(header + rows, { headers })
}
