import Link from 'next/link'
import { toChecksumAddress, shortenAddress } from '@/lib/address-display'
import { getAddressLabel } from '@/lib/known-addresses'
// chain-client: this component is rendered inside client components too.
import { chainConfig } from '@/lib/chain-client'

/**
 * The single place an address becomes visible text.
 *
 * Two invariants it exists to hold everywhere at once:
 *  - the href stays LOWERCASE, because that is the DB primary key;
 *  - the visible text is EIP-55 checksummed, because that is what a user
 *    copies into a wallet, and a lowercase address carries no checksum at all.
 *
 * A known label replaces the hex entirely (as Etherscan does), with the full
 * checksummed address kept in `title` so it is still readable on hover.
 */
export function AddressLink({
  address,
  short = true,
  showLabel = true,
  self = false,
  className = '',
}: {
  address: string
  /** Truncate to `0x5aAeb6…BeAed`. Pass false on detail pages that show it in full. */
  short?: boolean
  showLabel?: boolean
  /** True when this address IS the page's subject — rendered as plain emphasis
   *  rather than an action-coloured link, so a row does not look like it links
   *  somewhere new. */
  self?: boolean
  className?: string
}) {
  const checksummed = toChecksumAddress(address)
  const label = showLabel ? getAddressLabel(address) : null
  const text = label ?? (short ? shortenAddress(address) : checksummed)

  return (
    <Link
      href={`/address/${address.toLowerCase()}`}
      title={checksummed}
      className={`${self ? 'text-gray-800 font-semibold' : `${chainConfig.theme.linkText} hover:underline`} ${label ? '' : 'font-mono'} ${className}`}
    >
      {text}
    </Link>
  )
}
