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
