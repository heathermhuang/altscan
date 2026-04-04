import { db, schema } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatNativeToken, formatGwei, formatNumber, timeAgo, safeBigInt } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import Link from 'next/link'
import type { Metadata } from 'next'
import { decodeTx } from '@/lib/tx-decoder'
import { getAddressLabel } from '@/lib/known-addresses'
import { fetchTxFromRpc, type RpcTx } from '@/lib/rpc-fallback'
import { decodeEventName, decodeTopicParam } from '@/lib/event-decoder'

export const revalidate = 30

async function fetchNativePrice(): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) return null
    const data = await res.json()
    return data[chainConfig.coingeckoId]?.usd ?? null
  } catch {
    return null
  }
}

async function fetchChainTip(): Promise<number | null> {
  try {
    const [row] = await db.select({ max: sql<number>`MAX(number)` }).from(schema.blocks)
    return row?.max ?? null
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: { params: Promise<{ hash: string }> }): Promise<Metadata> {
  const { hash } = await params
  let tx: typeof schema.transactions.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash)).limit(1)
    tx = row ?? null
  } catch { /* DB error */ }
  if (!tx) return { title: `Transaction Not Found — ${chainConfig.brandName}` }
  const val = formatNativeToken(safeBigInt(tx.value))
  return {
    title: `Tx ${hash.slice(0, 18)}… — ${chainConfig.brandName}`,
    description: `${chainConfig.name} transaction: ${val} ${chainConfig.currency} from ${tx.fromAddress.slice(0, 12)}… to ${(tx.toAddress ?? 'contract creation').slice(0, 12)}…`,
    openGraph: {
      title: `Transaction ${hash.slice(0, 18)}…`,
      description: `${val} ${chainConfig.currency} · Block #${tx.blockNumber} · ${tx.status ? 'Success' : 'Failed'}`,
    },
  }
}

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

const TX_TYPE_LABELS: Record<number, string> = {
  0: 'Legacy',
  1: 'EIP-2930 (Access List)',
  2: 'EIP-1559 (Dynamic Fee)',
  3: 'EIP-4844 (Blob)',
}

async function resolveMethodName(methodId: string): Promise<string | null> {
  if (!methodId || methodId === '0x' || methodId.length < 10) return null
  if (KNOWN_SIGNATURES[methodId]) return KNOWN_SIGNATURES[methodId]
  try {
    const res = await fetch(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${methodId}`,
      { next: { revalidate: 86400 }, signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { results?: { text_signature: string }[] }
    return data.results?.[0]?.text_signature ?? null
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

function decodeTransferInput(input: string | null): { to: string; amount: bigint } | null {
  if (!input || input.length !== 138) return null
  try {
    const to = ('0x' + input.slice(34, 74)).toLowerCase()
    const amount = BigInt('0x' + input.slice(74))
    if (!/^0x[0-9a-f]{40}$/.test(to)) return null
    return { to, amount }
  } catch {
    return null
  }
}

function formatUsd(nativeAmount: number, price: number): string {
  const usd = nativeAmount * price
  if (usd < 0.01 && usd > 0) return '< $0.01'
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default async function TxDetailPage({
  params,
}: {
  params: Promise<{ hash: string }>
}) {
  const { hash } = await params
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) notFound()

  let dbTx: typeof schema.transactions.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash))
    dbTx = row ?? null
  } catch { /* DB error — fall through to RPC */ }

  const rpcTx: RpcTx | null = !dbTx ? await fetchTxFromRpc(hash) : null
  const tx = dbTx ?? rpcTx
  if (!tx) notFound()

  const fromRpc = !dbTx && !!rpcTx

  const [txLogs, transfers, methodName, nativePrice, chainTip] = await Promise.all([
    fromRpc
      ? Promise.resolve([])
      : db.select().from(schema.logs).where(eq(schema.logs.txHash, hash)).limit(50).catch(() => []),
    fromRpc
      ? Promise.resolve([])
      : db.select().from(schema.tokenTransfers).where(eq(schema.tokenTransfers.txHash, hash)).limit(25).catch(() => []),
    tx.methodId && tx.methodId !== '0x'
      ? resolveMethodName(tx.methodId)
      : Promise.resolve(null),
    fetchNativePrice(),
    fetchChainTip(),
  ])

  const fee = BigInt(tx.gasUsed ?? 0) * BigInt(tx.gasPrice ?? 0)
  const hasInput = tx.input && tx.input !== '0x'
  const decodedUtf8 = hasInput ? tryDecodeInputAsUtf8(tx.input) : null

  // Gas usage percentage
  const gasUsed = BigInt(tx.gasUsed ?? 0)
  const gasLimit = BigInt(tx.gas ?? 0)
  const MAX_REASONABLE_GAS = 50_000_000n
  const gasPercent = gasLimit > 0n && gasLimit < MAX_REASONABLE_GAS && gasUsed < MAX_REASONABLE_GAS
    ? Number((gasUsed * 100n) / gasLimit)
    : null

  // USD values
  const bnbValue = Number(safeBigInt(tx.value)) / 1e18
  const feeVal = Number(fee) / 1e18
  const valueUsd = nativePrice ? formatUsd(bnbValue, nativePrice) : null
  const feeUsd = nativePrice ? formatUsd(feeVal, nativePrice) : null

  // Confirmations
  const confirmations = chainTip ? chainTip - tx.blockNumber : null

  // Nonce + txType — prefer DB, fallback to RPC
  const nonce = tx.nonce ?? (fromRpc ? (rpcTx as RpcTx).nonce : null)
  const txType = tx.txType ?? (fromRpc ? (rpcTx as RpcTx).txType : null)

  const transferInfos = await Promise.all(
    transfers.map(async (t) => {
      let tokenSymbol: string | undefined
      let tokenDecimals: number | undefined
      try {
        const [tok] = await db.select({ symbol: schema.tokens.symbol, decimals: schema.tokens.decimals })
          .from(schema.tokens)
          .where(eq(schema.tokens.address, t.tokenAddress))
          .limit(1)
        if (tok) { tokenSymbol = tok.symbol; tokenDecimals = tok.decimals }
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

  // Fallback: decode transfer from input data
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
          href={`${chainConfig.externalExplorerUrl}/tx/${hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`ml-auto text-xs text-gray-400 hover:${chainConfig.theme.linkText} border border-gray-200 hover:${chainConfig.theme.border} rounded px-2 py-1 transition-colors`}
        >
          View on {chainConfig.externalExplorer} ↗
        </a>
      </div>

      {fromRpc && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-amber-800">
          <span>⚡</span>
          <span>Fetched live from {chainConfig.name} — this transaction predates our index.</span>
        </div>
      )}

      {decoded && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-3">
          <span className="text-2xl">{decoded.emoji}</span>
          <p className="text-sm text-yellow-800">{decoded.summary}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y">
            <Row label="Transaction Hash" value={tx.hash} mono copy />
            <Row label="Status" value={tx.status ? 'Success' : 'Failed'} />
            <tr>
              <td className="px-6 py-3 text-gray-500 w-44 font-medium shrink-0">Block</td>
              <td className="px-6 py-3">
                <Link href={`/blocks/${tx.blockNumber}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                  {String(tx.blockNumber)}
                </Link>
                {confirmations != null && confirmations > 0 && (
                  <span className="ml-2 text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                    {formatNumber(confirmations)} Confirmations
                  </span>
                )}
              </td>
            </tr>
            <Row
              label="Timestamp"
              value={`${timeAgo(new Date(tx.timestamp))} (${new Date(tx.timestamp).toUTCString()})`}
            />
            <Row
              label="From"
              value={tx.fromAddress}
              mono copy
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
            <tr>
              <td className="px-6 py-3 text-gray-500 w-44 font-medium shrink-0">Value</td>
              <td className="px-6 py-3">
                {formatNativeToken(safeBigInt(tx.value))} {chainConfig.currency}
                {valueUsd && <span className="text-gray-400 ml-1">({valueUsd})</span>}
              </td>
            </tr>
            <tr>
              <td className="px-6 py-3 text-gray-500 w-44 font-medium shrink-0">Transaction Fee</td>
              <td className="px-6 py-3">
                {formatNativeToken(fee)} {chainConfig.currency}
                {feeUsd && <span className="text-gray-400 ml-1">({feeUsd})</span>}
              </td>
            </tr>
            <Row
              label="Gas Price"
              value={`${formatGwei(BigInt(tx.gasPrice ?? 0))} Gwei`}
            />
            <tr>
              <td className="px-6 py-3 text-gray-500 w-44 font-medium shrink-0">Gas Used / Limit</td>
              <td className="px-6 py-3">
                <span>
                  {gasUsed > 0n && gasUsed < MAX_REASONABLE_GAS ? formatNumber(Number(gasUsed)) : '—'}
                  {' / '}
                  {gasLimit > 0n && gasLimit < MAX_REASONABLE_GAS ? formatNumber(Number(gasLimit)) : '—'}
                </span>
                {gasPercent != null && (
                  <span className="ml-2 text-xs text-gray-500">({gasPercent}%)</span>
                )}
                {gasPercent != null && (
                  <div className="mt-1 w-48 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-yellow-500"
                      style={{ width: `${Math.min(gasPercent, 100)}%` }}
                    />
                  </div>
                )}
              </td>
            </tr>
            {tx.methodId && tx.methodId !== '0x' && (
              <Row
                label="Method"
                value={methodName ? `${methodName} (${tx.methodId})` : tx.methodId}
                mono
              />
            )}
            {nonce != null && (
              <Row label="Nonce" value={String(nonce)} />
            )}
            <Row label="Position In Block" value={String(tx.txIndex)} />
            {txType != null && (
              <Row label="Transaction Type" value={TX_TYPE_LABELS[txType] ?? `Type ${txType}`} />
            )}
          </tbody>
        </table>
      </div>

      {/* Input Data */}
      {hasInput && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <details>
            <summary className="cursor-pointer font-semibold text-sm select-none list-none flex items-center gap-2 group">
              <span className="group-open:rotate-90 transition-transform inline-block text-gray-400">▶</span>
              View Input Data
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <p className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wider">Hex</p>
                <pre className="bg-gray-50 border rounded p-3 text-xs font-mono overflow-auto max-h-48 break-all whitespace-pre-wrap">
                  {tx.input}
                </pre>
              </div>
              {decodedUtf8 && (
                <div>
                  <p className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wider">UTF-8 Decoded</p>
                  <pre className="bg-gray-50 border rounded p-3 text-xs font-mono overflow-auto max-h-48 break-all whitespace-pre-wrap">
                    {decodedUtf8}
                  </pre>
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {transferInfos.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <h2 className="font-semibold mb-3">Token Transfers ({transferInfos.length})</h2>
          <div className="space-y-2">
            {transferInfos.map((t, i) => {
              const formattedAmount = t.tokenDecimals != null
                ? (Number(BigInt(t.value)) / Math.pow(10, t.tokenDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })
                : null
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-gray-500">From</span>
                  <Link href={`/address/${t.fromAddress}`} className={`${chainConfig.theme.linkText} font-mono text-xs hover:underline`}>
                    {t.fromAddress.slice(0, 12)}...
                  </Link>
                  <span className="text-gray-500">To</span>
                  <Link href={`/address/${t.toAddress}`} className={`${chainConfig.theme.linkText} font-mono text-xs hover:underline`}>
                    {t.toAddress.slice(0, 12)}...
                  </Link>
                  <span className="text-gray-500">For</span>
                  <span className="font-medium">
                    {formattedAmount ?? t.value}
                    {' '}
                    <Link href={`/token/${t.tokenAddress}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {t.tokenSymbol ?? t.tokenAddress.slice(0, 10) + '…'}
                    </Link>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {txLogs.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <h2 className="font-semibold mb-3">Event Logs ({txLogs.length})</h2>
          <div className="space-y-3">
            {txLogs.map((log, i) => {
              const decoded = decodeEventName(log.topic0)
              return (
                <div key={i} className="bg-gray-50 rounded p-3 text-xs overflow-auto">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-gray-400 font-mono">#{i}</span>
                    <Link href={`/address/${log.address}`} className={`${chainConfig.theme.linkText} hover:underline font-mono`}>
                      {log.address}
                    </Link>
                    {decoded && (
                      <span className="bg-yellow-100 text-yellow-700 rounded px-1.5 py-0.5 font-semibold text-xs">
                        {decoded.name}
                      </span>
                    )}
                  </div>
                  <div className="space-y-1 pl-6">
                    {log.topic0 && (
                      <div className="flex gap-2">
                        <span className="text-gray-400 w-14 shrink-0">Topic0</span>
                        <span className="font-mono text-gray-600 break-all">{log.topic0}</span>
                      </div>
                    )}
                    {log.topic1 && (
                      <div className="flex gap-2">
                        <span className="text-gray-400 w-14 shrink-0">Topic1</span>
                        <span className="font-mono break-all">
                          <span className="text-gray-600">{log.topic1}</span>
                          {decoded && decoded.params[0] && (
                            <span className="text-yellow-600 ml-2">→ {decoded.params[0]}: {decodeTopicParam(log.topic1)}</span>
                          )}
                        </span>
                      </div>
                    )}
                    {log.topic2 && (
                      <div className="flex gap-2">
                        <span className="text-gray-400 w-14 shrink-0">Topic2</span>
                        <span className="font-mono break-all">
                          <span className="text-gray-600">{log.topic2}</span>
                          {decoded && decoded.params[1] && (
                            <span className="text-yellow-600 ml-2">→ {decoded.params[1]}: {decodeTopicParam(log.topic2)}</span>
                          )}
                        </span>
                      </div>
                    )}
                    {log.data && log.data !== '0x' && (
                      <div className="flex gap-2">
                        <span className="text-gray-400 w-14 shrink-0">Data</span>
                        <span className="font-mono text-gray-600 break-all">
                          {log.data.slice(0, 130)}{log.data.length > 130 ? '…' : ''}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({
  label, value, mono = false, copy = false, link, addressLabel,
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
          <Link href={link} className={`${chainConfig.theme.linkText} hover:underline`}>{value}</Link>
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
