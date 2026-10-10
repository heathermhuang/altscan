import Link from 'next/link'
import { formatNumber } from '@/lib/format'
import { shortenAddress, shortHash } from '@/lib/address-display'
import { anyLinkLike } from '@/lib/link-in-name'
import { LinkInName } from '@/components/ui/LinkInName'

export type NftTransfer = {
  txHash: string
  tokenAddress: string
  tokenId: string | null
  fromAddress: string
  toAddress: string
  blockNumber: number
  name?: string
  symbol?: string
}

/** One row of the address page's NFTs tab (the server render; NftsLazy draws the provider's holdings as cards). */
export function NftRow({ t, addr }: { t: NftTransfer; addr: string }) {
  // Both texts are printed as given, so both are judged. The text stays text; nothing here links to it.
  const linkLike = anyLinkLike(t.name, t.symbol)
  return (
    <tr className="hover:bg-canvas transition-colors">
      <td className="px-3 sm:px-4 py-2">
        <Link href={`/token/${t.tokenAddress}`} className={linkLike ? 'text-acc-ink hover:underline font-medium' : 'text-acc-ink hover:underline'}>
          {t.name ?? shortenAddress(t.tokenAddress)}
        </Link>
        {t.symbol && <span className="ml-1 text-xs text-mut">({t.symbol})</span>}
        {linkLike && <LinkInName className="ml-2" />}
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        #{t.tokenId}
      </td>
      <td className="px-3 sm:px-4 py-2">
        <span className={`font-mono text-xs font-medium ${t.toAddress.toLowerCase() === addr ? 'text-live' : 'text-warn'}`}>
          {t.toAddress.toLowerCase() === addr ? 'Received' : 'Sent'}
        </span>
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        <Link href={`/tx/${t.txHash}`} className="text-acc-ink hover:underline">
          {shortHash(t.txHash)}
        </Link>
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-mut">{formatNumber(t.blockNumber)}</td>
    </tr>
  )
}
