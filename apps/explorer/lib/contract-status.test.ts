import { describe, expect, it } from 'vitest'
import { classifyCode, resolveContractStatus, resolveNativeBalance } from './contract-status'

/**
 * These pin two facts that were silently wrong on every address page.
 *
 * 1. `addresses.is_contract` is ALWAYS false. block-processor.ts:747 is its only
 *    writer and it inserts the literal `false`; its ON CONFLICT clause updates
 *    only tx_count and last_seen. Nothing anywhere sets it true. The page gated
 *    the Contract badge AND the whole verified-contract section on it, so contract
 *    verification was invisible sitewide.
 * 2. `addresses.balance` is ALWAYS the literal '0'::numeric, written once on
 *    insert and never updated. It was the RPC-failure fallback, so a failed
 *    getBalance rendered a confident "0 BNB" instead of admitting it did not know.
 *
 * The `contracts` table is NOT a contract registry — contract-verifier.ts only
 * inserts on a successful Sourcify verification (it even stores bytecode: '').
 * So presence there proves "is a contract", but absence proves nothing.
 */
describe('resolveContractStatus', () => {
  it('reads real bytecode as a contract', () => {
    expect(resolveContractStatus({ code: '0x60806040523480', verified: false }))
      .toEqual({ isContract: true, known: true })
  })

  it('reads empty code as an EOA', () => {
    expect(resolveContractStatus({ code: '0x', verified: false }))
      .toEqual({ isContract: false, known: true })
  })

  it.each(['0x', '0X', '  0x  '])('treats %j as an empty account', (code) => {
    expect(resolveContractStatus({ code, verified: false }))
      .toEqual({ isContract: false, known: true })
  })

  it('classifies 0x00 as a CONTRACT — opcode 0x00 is STOP, not emptiness', () => {
    // The bug codex caught. A non-zero-digit test reads all-zero bytecode as
    // "empty" and confidently calls a deployed contract an EOA. Only the exact
    // string 0x means no code.
    expect(classifyCode('0x00')).toBe('code')
    expect(resolveContractStatus({ code: '0x00', verified: false }))
      .toEqual({ isContract: true, known: true })
  })

  it.each(['0x0', '0xzz', '', 'garbage', '0x123'])('treats %j as malformed → UNKNOWN', (code) => {
    // Bytecode is whole bytes, so odd-length or non-hex is a broken answer, not a
    // node reporting an empty account. It must not become a confident EOA.
    expect(classifyCode(code)).toBe('malformed')
    expect(resolveContractStatus({ code, verified: false }))
      .toEqual({ isContract: false, known: false })
  })

  it('a malformed response still defers to the verified registry', () => {
    expect(resolveContractStatus({ code: '0x0', verified: true }))
      .toEqual({ isContract: true, known: true })
  })

  it('classifies real bytecode of any even length as code', () => {
    for (const c of ['0x00', '0xff', '0x6080', '0x60806040523480']) {
      expect(classifyCode(c), c).toBe('code')
    }
  })

  it('still calls a self-destructed but verified contract a contract', () => {
    // SELFDESTRUCT removes the code, so getCode returns 0x. Registry presence is
    // proof it WAS deployed; calling it an EOA would be a lie.
    expect(resolveContractStatus({ code: '0x', verified: true }))
      .toEqual({ isContract: true, known: true })
  })

  it('falls back to the verified registry when the RPC call failed', () => {
    expect(resolveContractStatus({ code: null, verified: true }))
      .toEqual({ isContract: true, known: true })
  })

  it('admits it does NOT know when the RPC failed and the address is unverified', () => {
    // The important case. The old code reported `false` here — indistinguishable
    // from a real EOA — which is exactly how an unverified contract rendered as a
    // plain address. Absence of evidence is not evidence of absence.
    expect(resolveContractStatus({ code: null, verified: false }))
      .toEqual({ isContract: false, known: false })
  })

  it('never reports known:false when it reported isContract:true', () => {
    for (const code of ['0x', '0x60806040', null, '', '0x0']) {
      for (const verified of [true, false]) {
        const r = resolveContractStatus({ code, verified })
        if (r.isContract) expect(r.known, `code=${code} verified=${verified}`).toBe(true)
      }
    }
  })
})

describe('resolveNativeBalance', () => {
  it('uses the live RPC balance when available', () => {
    expect(resolveNativeBalance({ live: 1234n, indexed: '999' }))
      .toEqual({ value: 1234n, known: true })
  })

  it('reports UNKNOWN when the RPC failed — it must not fall back to the index', () => {
    // The indexed column is a literal '0' that is never updated, so surfacing it
    // renders a confidently wrong "0 BNB". Unknown is the honest answer.
    expect(resolveNativeBalance({ live: null, indexed: '0' }))
      .toEqual({ value: 0n, known: false })
  })

  it('ignores a non-zero indexed balance too — the column is stale by construction', () => {
    // Guards against someone "helpfully" restoring the fallback because the value
    // looked real. Nothing maintains this column; a non-zero value is stale, not fresh.
    expect(resolveNativeBalance({ live: null, indexed: '5000000000000000000' }))
      .toEqual({ value: 0n, known: false })
  })

  it('treats a live zero balance as known, not missing', () => {
    // A genuinely empty wallet must render "0", not "unavailable".
    expect(resolveNativeBalance({ live: 0n, indexed: null }))
      .toEqual({ value: 0n, known: true })
  })
})
