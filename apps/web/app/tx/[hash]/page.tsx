import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatBNB, formatGwei, formatNumber, timeAgo } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import Link from 'next/link'
import type { Metadata } from 'next'
import { decodeTx } from '@/lib/tx-decoder'
import { getAddressLabel } from '@/lib/known-addresses'
import { fetchTxFromRpc, type RpcTx } from '@/lib/rpc-fallback'
import { getProvider } from '@/lib/rpc'

export async function generateMetadata({ params }: { params: Promise<{ hash: string }> }): Promise<Metadata> {
  const { hash } = await params
  let tx: typeof schema.transactions.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash)).limit(1)
    tx = row ?? null
  } catch { /* DB error */ }
  if (!tx) return { title: 'Transaction Not Found — BNBScan' }
  const val = formatBNB(BigInt((tx.value ?? '0').split('.')[0]))
  return {
    title: `Tx ${hash.slice(0, 18)}… — BNBScan`,
    description: `BNB Chain transaction: ${val} BNB from ${tx.fromAddress.slice(0, 12)}… to ${(tx.toAddress ?? 'contract creation').slice(0, 12)}…`,
    openGraph: {
      title: `Transaction ${hash.slice(0, 18)}…`,
      description: `${val} BNB · Block #${tx.blockNumber} · ${tx.status ? '✅ Success' : '❌ Failed'}`,
    },
  }
}

// Canonical method signatures — take precedence over 4byte.directory (which has collisions)
const KNOWN_SIGNATURES: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x38ed1739': 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  '0x18cbafe5': 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  '0x7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  '0xe8e33700': 'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
  '0xbaa2abde': 'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
  '0xd0e30db0': 'deposit()',
  '0x2e1a7d4d': 'withdraw(uint256)',
}

async function resolveMethodName(methodId: string): Promise<string | null> {
  if (!methodId || methodId === '0x' || methodId.length < 10) return null
  // Use canonical name if known — avoids 4byte.directory collisions
  if (KNOWN_SIGNATURES[methodId]) return KNOWN_SIGNATURES[methodId]
  try {
    const res = await fetch(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${methodId}`,
      { next: { revalidate: 86400 } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      results?: { text_signature: string }[]
    }
    return data.results?.[0]?.text_signature ?? null
  } catch {
    return null
  }
}

// Decode ERC-20 transfer(address,uint256) call data
function decodeTransferInput(input: string | null): { to: string; amount: bigint } | null {
  if (!input || input.length !== 138) return null // 0x + 8 + 64 + 64
  try {
    const to = ('0x' + input.slice(34, 74)).toLowerCase()
    const amount = BigInt('0x' + input.slice(74))
    if (!/^0x[0-9a-f]{40}$/.test(to)) return null
    return { to, amount }
  } catch {
    return null
  }
}

function tryDecodeInputAsUtf8(input: string): string | null {
  if (!input || input === '0x') return null
  try {
    const hex = input.startsWith('0x') ? input.slice(2) : input
    if (hex.length === 0) return null
    const bytes = Buffer.from(hex, 'hex')
    const decoded = bytes.toString('utf8')
    // Only return if it has enough printable characters (>50% printable)
    const printableCount = decoded.split('').filter((c) => {
      const code = c.charCodeAt(0)
      return code >= 32 && code < 127
    }).length
    if (printableCount / decoded.length > 0.5 && printableCount > 3) {
      return decoded
    }
    return null
  } catch {
    return null
  }
}

export default async function TxDetailPage({
  params,
}: {
  params: Promise<{ hash: string }>
}) {
  const { hash } = await params

  let dbTx: typeof schema.transactions.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash))
    dbTx = row ?? null
  } catch { /* DB error — fall through to RPC */ }

  const rpcTx: RpcTx | null = !dbTx ? await fetchTxFromRpc(hash) : null
  const tx = dbTx ?? rpcTx
  if (!tx) notFound()

  const fromRpc = !dbTx && !!rpcTx

  // If DB has gasUsed=0, fetch the receipt for real gas data
  let receiptGasUsed: bigint | null = null
  if (dbTx && Number(dbTx.gasUsed ?? 0) === 0) {
    try {
      const receipt = await getProvider().getTransactionReceipt(hash)
      if (receipt) receiptGasUsed = receipt.gasUsed
    } catch { /* ignore */ }
  }

  const [txLogs, transfers, methodName] = await Promise.all([
    fromRpc ? Promise.resolve([]) : db.select().from(schema.logs).where(eq(schema.logs.txHash, hash)).limit(50),
    fromRpc ? Promise.resolve([]) : db.select().from(schema.tokenTransfers).where(eq(schema.tokenTransfers.txHash, hash)).limit(25),
    tx.methodId && tx.methodId !== '0x'
      ? resolveMethodName(tx.methodId)
      : Promise.resolve(null),
  ])

  const fee = BigInt(tx.gasUsed ?? 0) * BigInt(tx.gasPrice ?? 0)
  const hasInput = tx.input && tx.input !== '0x'
  const decodedUtf8 = hasInput ? tryDecodeInputAsUtf8(tx.input) : null

  // Build transfer info for decoder (enrich with token symbol/decimals if available)
  const transferInfos = await Promise.all(
    transfers.map(async (t) => {
      let tokenSymbol: string | undefined
      let tokenDecimals: number | undefined
      try {
        const [tok] = await db.select({ symbol: schema.tokens.symbol, decimals: schema.tokens.decimals })
          .from(schema.tokens)
          .where(eq(schema.tokens.address, t.tokenAddress))
          .limit(1)
        if (tok) {
          tokenSymbol = tok.symbol
          tokenDecimals = tok.decimals
        }
      } catch { /* ignore */ }
      return {
        tokenAddress: t.tokenAddress,
        fromAddress: t.fromAddress,
        toAddress: t.toAddress,
        value: t.value ?? '0',
        tokenSymbol,
        tokenDecimals,
      }
    })
  )

  // If no DB transfers, try to decode from input data (works for RPC txs too)
  let decodedInputTransfer: { tokenAddress: string; to: string; amount: bigint; tokenSymbol?: string; tokenDecimals?: number } | null = null
  if (transferInfos.length === 0 && tx.methodId === '0xa9059cbb' && tx.toAddress) {
    const parsed = decodeTransferInput(tx.input ?? null)
    if (parsed) {
      let tokenSymbol: string | undefined
      let tokenDecimals: number | undefined
      try {
        const [tok] = await db.select({ symbol: schema.tokens.symbol, decimals: schema.tokens.decimals })
          .from(schema.tokens).where(eq(schema.tokens.address, tx.toAddress.toLowerCase())).limit(1)
        if (tok) { tokenSymbol = tok.symbol; tokenDecimals = tok.decimals }
      } catch { /* ignore */ }
      decodedInputTransfer = { tokenAddress: tx.toAddress, to: parsed.to, amount: parsed.amount, tokenSymbol, tokenDecimals }
      transferInfos.push({
        tokenAddress: tx.toAddress,
        fromAddress: tx.fromAddress,
        toAddress: parsed.to,
        value: parsed.amount.toString(),
        tokenSymbol,
        tokenDecimals,
      })
    }
  }

  const decoded = decodeTx(
    {
      hash: tx.hash,
      fromAddress: tx.fromAddress,
      toAddress: tx.toAddress,
      value: tx.value ?? '0',
      methodId: tx.methodId,
      status: tx.status,
      methodName,
    },
    transferInfos
  )

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Transaction Details</h1>
        <Badge variant={tx.status ? 'success' : 'fail'}>
          {tx.status ? 'Success' : 'Failed'}
        </Badge>
        <a
          href={`https://bscscan.com/tx/${hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-xs text-gray-400 hover:text-yellow-600 border border-gray-200 hover:border-yellow-400 rounded px-2 py-1 transition-colors"
        >
          View on BscScan ↗
        </a>
      </div>

      {fromRpc && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-amber-800">
          <span>⚡</span>
          <span>Fetched live from BNB Chain — this transaction predates our index.{!decodedInputTransfer && ' Token transfer details are not available.'}</span>
        </div>
      )}

      {decoded && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-3">
          <span className="text-2xl">{decoded.emoji}</span>
          <p className="text-sm text-blue-800">{decoded.summary}</p>
        </div>
      )}

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
              addressLabel={getAddressLabel(tx.fromAddress)}
            />
            <Row
              label="To"
              value={tx.toAddress ?? 'Contract Creation'}
              mono
              copy={!!tx.toAddress}
              link={tx.toAddress ? `/address/${tx.toAddress}` : undefined}
              addressLabel={tx.toAddress ? getAddressLabel(tx.toAddress) : null}
            />
            <Row
              label="Value"
              value={`${formatBNB(BigInt((tx.value ?? '0').split('.')[0]))} BNB`}
            />
            <Row label="Transaction Fee" value={`${formatBNB(fee)} BNB`} />
            <Row
              label="Gas Price"
              value={`${formatGwei(BigInt(tx.gasPrice ?? 0))} Gwei`}
            />
            <Row
              label="Gas Used / Limit"
              value={(() => {
                // Guard against Long.MAX_VALUE sentinel (9223372036854775807) from indexer overflow
                const MAX_REASONABLE_GAS = 50_000_000n
                const gasUsed = receiptGasUsed ?? BigInt(tx.gasUsed ?? 0)
                const gasLimit = BigInt(tx.gas ?? 0)
                const usedStr = gasUsed > 0n && gasUsed < MAX_REASONABLE_GAS ? formatNumber(Number(gasUsed)) : '—'
                const limitStr = gasLimit > 0n && gasLimit < MAX_REASONABLE_GAS ? formatNumber(Number(gasLimit)) : '—'
                return `${usedStr} / ${limitStr}`
              })()}
            />
            {tx.methodId && tx.methodId !== '0x' && (
              <Row
                label="Method"
                value={
                  methodName
                    ? `${methodName} (${tx.methodId})`
                    : tx.methodId
                }
                mono
              />
            )}
          </tbody>
        </table>
      </div>

      {/* Input Data */}
      {hasInput && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <details>
            <summary className="cursor-pointer font-semibold text-sm select-none list-none flex items-center gap-2 group">
              <span className="group-open:rotate-90 transition-transform inline-block text-gray-400">
                ▶
              </span>
              View Input Data
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <p className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wider">
                  Hex
                </p>
                <pre className="bg-gray-50 border rounded p-3 text-xs font-mono overflow-auto max-h-48 break-all whitespace-pre-wrap">
                  {tx.input}
                </pre>
              </div>
              {decodedUtf8 && (
                <div>
                  <p className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wider">
                    UTF-8 Decoded
                  </p>
                  <pre className="bg-gray-50 border rounded p-3 text-xs font-mono overflow-auto max-h-48 break-all whitespace-pre-wrap">
                    {decodedUtf8}
                  </pre>
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {(transfers.length > 0 || decodedInputTransfer) && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <h2 className="font-semibold mb-3">Token Transfers ({transfers.length || 1})</h2>
          <div className="space-y-2">
            {transfers.map((t, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-500">From</span>
                <Link href={`/address/${t.fromAddress}`} className="text-blue-600 font-mono text-xs hover:underline">
                  {t.fromAddress.slice(0, 12)}...
                </Link>
                <span className="text-gray-500">To</span>
                <Link href={`/address/${t.toAddress}`} className="text-blue-600 font-mono text-xs hover:underline">
                  {t.toAddress.slice(0, 12)}...
                </Link>
                <span className="text-gray-500">Token</span>
                <Link href={`/token/${t.tokenAddress}`} className="text-yellow-600 hover:underline">
                  {t.tokenAddress.slice(0, 12)}...
                </Link>
              </div>
            ))}
            {decodedInputTransfer && transfers.length === 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-500">From</span>
                <Link href={`/address/${tx.fromAddress}`} className="text-blue-600 font-mono text-xs hover:underline">
                  {tx.fromAddress.slice(0, 12)}...
                </Link>
                <span className="text-gray-500">To</span>
                <Link href={`/address/${decodedInputTransfer.to}`} className="text-blue-600 font-mono text-xs hover:underline">
                  {decodedInputTransfer.to.slice(0, 12)}...
                </Link>
                <span className="text-gray-500">For</span>
                <span className="font-medium">
                  {decodedInputTransfer.tokenDecimals != null
                    ? (Number(decodedInputTransfer.amount) / Math.pow(10, decodedInputTransfer.tokenDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })
                    : decodedInputTransfer.amount.toString()}
                  {' '}{decodedInputTransfer.tokenSymbol && (
                    <Link href={`/token/${decodedInputTransfer.tokenAddress}`} className="text-yellow-600 hover:underline">
                      {decodedInputTransfer.tokenSymbol}
                    </Link>
                  )}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {txLogs.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <h2 className="font-semibold mb-3">Event Logs ({txLogs.length})</h2>
          <div className="space-y-3">
            {txLogs.map((log, i) => (
              <div
                key={i}
                className="bg-gray-50 rounded p-3 font-mono text-xs overflow-auto"
              >
                <div>
                  <span className="text-gray-500">Address: </span>
                  <Link
                    href={`/address/${log.address}`}
                    className="text-blue-600 hover:underline"
                  >
                    {log.address}
                  </Link>
                </div>
                {log.topic0 && (
                  <div>
                    <span className="text-gray-500">Topic0: </span>
                    {log.topic0}
                  </div>
                )}
                {log.topic1 && (
                  <div>
                    <span className="text-gray-500">Topic1: </span>
                    {log.topic1}
                  </div>
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
  addressLabel,
}: {
  label: string
  value: string
  mono?: boolean
  copy?: boolean
  link?: string
  addressLabel?: string | null
}) {
  return (
    <tr>
      <td className="px-6 py-3 text-gray-500 w-44 font-medium shrink-0">{label}</td>
      <td className={`px-6 py-3 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {link ? (
          <Link href={link} className="text-blue-600 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
        {copy && <CopyButton text={value} />}
        {addressLabel && (
          <span className="ml-2 text-xs bg-yellow-100 text-yellow-800 border border-yellow-200 rounded px-1.5 py-0.5">
            {addressLabel}
          </span>
        )}
      </td>
    </tr>
  )
}
