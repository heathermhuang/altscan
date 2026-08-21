/**
 * Contract-ness and native balance for an address page, resolved from sources
 * that are actually maintained.
 *
 * Both of these used to be read off the `addresses` table, and both were wrong:
 *
 *  - `addresses.is_contract` is ALWAYS false. apps/indexer/src/block-processor.ts
 *    is its only writer; it inserts the literal `false` and its ON CONFLICT clause
 *    updates only tx_count and last_seen. Nothing in the repo ever sets it true.
 *    The address page gated the Contract badge AND the entire verified-contract
 *    section on it, so contract verification never rendered for anyone.
 *  - `addresses.balance` is ALWAYS the literal '0'::numeric, written once on
 *    insert and never updated. It was the fallback when live getBalance failed,
 *    which turned an RPC blip into a confident, wrong "0 BNB".
 *
 * Populating is_contract at index time is not a real option: the only complete
 * signal is eth_getCode per address, and BSC mints thousands of new addresses per
 * block. Contract creations seen in receipts would cover only contracts deployed
 * while we were indexing, leaving the same false-means-"unknown" ambiguity that
 * caused this bug. So contract-ness is derived at READ time, where one getCode
 * call rides along in an RPC batch the page already issues.
 */

export type ContractStatus = {
  isContract: boolean
  /** false only when nothing could determine it (RPC failed, not in the registry). */
  known: boolean
}

/** eth_getCode returns '0x' for an account with no code. Be liberal about shape. */
function hasBytecode(code: string): boolean {
  const c = code.trim().toLowerCase()
  if (!c.startsWith('0x')) return c.length > 0 && /[1-9a-f]/.test(c)
  // '0x', '0x0', '0x00', '0x0000…' all mean "no code".
  return /[1-9a-f]/.test(c.slice(2))
}

/**
 * @param code     eth_getCode result, or null if the call failed.
 * @param verified whether the address is present in the `contracts` table.
 *
 * ⚠ `verified` is one-directional evidence. contract-verifier.ts only inserts on
 * a successful Sourcify verification, so presence PROVES the address is a
 * contract, while absence proves nothing at all — most BSC contracts are
 * unverified. Never treat `!verified` as "is an EOA".
 */
export function resolveContractStatus(input: { code: string | null; verified: boolean }): ContractStatus {
  const { code, verified } = input
  if (code !== null) {
    // A verified contract that self-destructed returns '0x'. It was still deployed
    // as a contract, and the page has verified source to show for it, so the
    // registry wins over the absent bytecode rather than the other way round.
    return { isContract: hasBytecode(code) || verified, known: true }
  }
  // RPC failed. The registry can still prove a contract, but it can never
  // disprove one — so an unverified address here is UNKNOWN, not an EOA.
  return verified ? { isContract: true, known: true } : { isContract: false, known: false }
}

export type NativeBalance = {
  value: bigint
  /** false when the live lookup failed — render "unavailable", never a zero. */
  known: boolean
}

/**
 * @param live    live getBalance result, or null if the call failed.
 * @param indexed addresses.balance. Accepted only to document that it is
 *                deliberately IGNORED: nothing maintains the column, so any value
 *                it holds is wrong rather than merely stale.
 */
export function resolveNativeBalance(input: {
  live: bigint | null
  indexed: string | null | undefined
}): NativeBalance {
  // `!== null`, never truthiness: 0n is a real, known, empty wallet.
  if (input.live !== null) return { value: input.live, known: true }
  return { value: 0n, known: false }
}
