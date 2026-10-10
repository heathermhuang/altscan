/**
 * EIP-55 address display helpers.
 *
 * The DB stores every address lowercased (it is the primary key), which is
 * correct for lookups and wrong for display: a lowercase address carries no
 * checksum, so a user who copies one out of a page and pastes it into a wallet
 * gets no protection against a typo or a swapped character. Etherscan and
 * BscScan both render the EIP-55 mixed-case form for exactly this reason.
 *
 * Storage stays lowercase. Only the render boundary changes.
 */
import { getAddress } from 'ethers'
import { looksLikeUrlOrHandle } from './link-in-name'

/**
 * EIP-55 checksummed form of `address`.
 *
 * Never throws: every caller is inside a server component's render, where an
 * exception on one malformed row would blank the whole page. Anything that is
 * not a well-formed address passes through untouched so the raw value is still
 * visible and diagnosable.
 *
 * Input casing is ignored — the checksum is re-derived from the hex digits, so
 * an address arriving with a WRONG checksum is corrected rather than echoed.
 */
export function toChecksumAddress(address: string): string {
  if (!address) return ''
  try {
    return getAddress(address.toLowerCase())
  } catch {
    return address
  }
}

/**
 * Truncated display form, checksum preserved: `0x5aAeb6…BeAed`.
 *
 * Malformed input is returned whole rather than sliced, so a bad value reads as
 * obviously bad instead of masquerading as a valid short address.
 */
export function shortenAddress(address: string, lead = 6, tail = 5): string {
  const checksummed = toChecksumAddress(address)
  if (!/^0x[0-9a-fA-F]{40}$/.test(checksummed)) return checksummed
  return `${checksummed.slice(0, 2 + lead)}…${checksummed.slice(-tail)}`
}

/**
 * Truncated transaction-hash display in the same shape as shortenAddress:
 * `0xa0188f…78946`. Hashes carry no checksum, so they render lowercase. Malformed
 * input is returned whole, for the same reason shortenAddress does.
 */
export function shortHash(hash: string, lead = 6, tail = 5): string {
  const lower = (hash ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(lower)) return hash ?? ''
  return `${lower.slice(0, 2 + lead)}…${lower.slice(-tail)}`
}

/**
 * The address page's H1: the curated label when there is one, else the kind and a short
 * form (`Wallet 0xabcd…1234`).
 *
 * Deliberately takes no resolved (ENS / .bnb) name. Those are self-chosen — anyone can register
 * "binance-hot-wallet.bnb" — so promoting one to the page's headline would let an address name
 * itself. It stays a badge. `||`, not `??`: an empty label is no label. Neither is a label that
 * reads as a URL or a handle (lib/link-in-name): that is an advert, not what the address is.
 */
export function addressHeadline(args: {
  label: string | null | undefined
  kind: string
  checksummed: string
}): string {
  const label = looksLikeUrlOrHandle(args.label) ? null : args.label
  return label || `${args.kind} ${shortenAddress(args.checksummed)}`
}
