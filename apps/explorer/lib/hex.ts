/**
 * The one definition of a well-formed address and 32-byte hash in the explorer.
 *
 * Two shapes, and they are NOT interchangeable:
 *  - `isHexAddress` / `isHexHash` accept any letter case. Use them on input from a URL,
 *    a form or an API caller, before normalizing it.
 *  - `isLowerHexAddress` / `isLowerHexHash` accept only lowercase, the form the database
 *    stores. Use them where the value must already be normalized (an owner read back
 *    from a token, a cursor we issued), so a mixed-case value is a caller bug, not input.
 *
 * Neither checks an EIP-55 checksum; ethers' isAddress does, and rejects a mistyped
 * mixed-case address, which these deliberately accept. hex.test.ts fails on a regex
 * literal of either shape anywhere else in apps/explorer.
 */

/** JSON-Schema `pattern` for an any-case address (OpenAPI, WebMCP tool schemas). */
export const ADDRESS_PATTERN = '^0x[0-9a-fA-F]{40}$'
/** JSON-Schema `pattern` for an any-case 32-byte hash (a transaction hash or a log topic). */
export const HASH_PATTERN = '^0x[0-9a-fA-F]{64}$'

const ADDRESS = new RegExp(ADDRESS_PATTERN)
const HASH = new RegExp(HASH_PATTERN)
const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/
const LOWER_HASH = /^0x[0-9a-f]{64}$/

export function isHexAddress(value: string): boolean {
  return ADDRESS.test(value)
}

export function isLowerHexAddress(value: string): boolean {
  return LOWER_ADDRESS.test(value)
}

export function isHexHash(value: string): boolean {
  return HASH.test(value)
}

export function isLowerHexHash(value: string): boolean {
  return LOWER_HASH.test(value)
}
