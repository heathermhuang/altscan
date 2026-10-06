import Link from 'next/link'
import { toChecksumAddress, shortenAddress } from '@/lib/address-display'
import { getAddressLabel } from '@/lib/known-addresses'

const SELF = 'text-ink font-semibold'

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
 *
 * `title={false}` leaves the `title` off, for list tables that render this twice a row:
 * the checksummed address is ~40 high-entropy characters, and the page ships it again in
 * its RSC payload, so it counts against the homepage's one-TCP-window budget. The href
 * still carries the full address.
 *
 * `plain` drops the link's own colour, hover and mono classes, for a container that supplies
 * them (a `dt-a` table: its links are accent links in the table's mono face). `self` still applies
 * there: its colour and weight are the one thing the container's accent must not decide.
 */
export function AddressLink({
  address,
  short = true,
  showLabel = true,
  self = false,
  title = true,
  plain = false,
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
  /** Put the full checksummed address in a `title` (hover text). Default true. */
  title?: boolean
  /** The container styles the link (see above): no colour, hover or font classes of its own, except `self`'s emphasis. */
  plain?: boolean
  className?: string
}) {
  const checksummed = toChecksumAddress(address)
  const label = showLabel ? getAddressLabel(address) : null
  const text = label ?? (short ? shortenAddress(address) : checksummed)

  return (
    <Link
      href={`/address/${address.toLowerCase()}`}
      title={title ? checksummed : undefined}
      className={plain ? `${self ? SELF : ''} ${className}`.trim() || undefined : `${self ? SELF : 'text-acc-ink hover:underline'} ${label ? '' : 'font-mono'} ${className}`}
    >
      {text}
    </Link>
  )
}
