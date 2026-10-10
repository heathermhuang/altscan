import Link from 'next/link'
import type { schema } from '@/lib/db'
import { formatNumber, formatTokenAmount, sanitizeSymbolOr, tokenLabel } from '@/lib/format'
import { shortHash } from '@/lib/address-display'
import { AddressLink } from '@/components/ui/AddressLink'

export type TransferTokenInfo = { name: string; symbol: string; decimals: number }

type Transfer = Pick<typeof schema.tokenTransfers.$inferSelect, 'txHash' | 'blockNumber' | 'fromAddress' | 'toAddress' | 'tokenAddress' | 'value'>

/** One row of the address page's Transfers tab (the server render; TransfersLazy has its own for the provider's rows). */
export function TransferRow({ t, addr, info }: { t: Transfer; addr: string; info: TransferTokenInfo | undefined }) {
  return (
    <tr className="hover:bg-canvas transition-colors">
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        <Link href={`/tx/${t.txHash}`} className="text-acc-ink hover:underline">
          {shortHash(t.txHash)}
        </Link>
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-mut">{formatNumber(t.blockNumber)}</td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        <AddressLink address={t.fromAddress} self={t.fromAddress.toLowerCase() === addr} />
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        <AddressLink address={t.toAddress} self={t.toAddress.toLowerCase() === addr} />
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        <Link
          href={`/token/${t.tokenAddress}`}
          className="text-acc-ink hover:underline"
        >
          {tokenLabel(info?.symbol, info?.name, t.tokenAddress)}
        </Link>
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        {(() => {
          const decimals = info?.decimals ?? 0
          const raw = t.value ?? '0'
          if (decimals > 0) {
            return <span title={formatTokenAmount(raw, decimals)}>{formatTokenAmount(raw, decimals, 6)}</span>
          }
          return raw.slice(0, 12)
        })()}
        {(() => {
          const sym = sanitizeSymbolOr(info?.symbol, '')
          return sym ? ` ${sym}` : ''
        })()}
      </td>
    </tr>
  )
}
