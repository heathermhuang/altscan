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

export type CodeClass = 'none' | 'code' | 'malformed'

/**
 * eth_getCode returns EXACTLY '0x' for an account with no code. Anything else
 * well-formed is a deployed program.
 *
 * ⚠ Do NOT test for a non-zero hex digit. `0x00` is one byte of runtime code
 * whose opcode is STOP — a real, deployed contract. Treating all-zero bytecode
 * as "empty" would confidently classify it as an EOA.
 *
 * Bytecode is whole bytes, so a well-formed answer is '0x' plus an EVEN number
 * of hex digits. An odd-length or non-hex response ('0x0', '') is not a node
 * telling us the account is empty — it is a broken answer, and it resolves to
 * 'malformed' so the caller reports UNKNOWN rather than inventing an EOA.
 */
export function classifyCode(code: string): CodeClass {
  const c = code.trim().toLowerCase()
  if (!/^0x([0-9a-f]{2})*$/.test(c)) return 'malformed'
  return c === '0x' ? 'none' : 'code'
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
    const cls = classifyCode(code)
    if (cls === 'code') return { isContract: true, known: true }
    if (cls === 'none') {
      // A verified contract that self-destructed returns '0x'. It was still
      // deployed as a contract and the page has verified source to show for it,
      // so the registry wins over the absent bytecode.
      return { isContract: verified, known: true }
    }
    // 'malformed' — a broken response tells us nothing, so fall through and be
    // treated exactly like a failed call rather than read as an empty account.
  }
  // RPC failed or answered garbage. The registry can still prove a contract, but
  // it can never disprove one — so an unverified address here is UNKNOWN, not an EOA.
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
