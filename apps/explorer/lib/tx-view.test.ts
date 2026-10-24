import { describe, expect, it } from 'vitest'
import {
  atCurrentPrice, inputMayBeTruncated, mayShowCalldataTransfer, needsInputRefetch, resolveStoredInput,
  resolveTxViewKind, STORED_INPUT_BYTES, STORED_INPUT_CHARS, TRUNCATED_INPUT_NOTE, txOutcome,
} from './tx-view'

describe('resolveTxViewKind', () => {
  it('local when row present and body not pruned', () => {
    expect(resolveTxViewKind({ bodyPruned: false }, null)).toBe('local')
  })
  it('pruned when row present and body_pruned', () => {
    expect(resolveTxViewKind({ bodyPruned: true }, null)).toBe('pruned')
  })
  it('rpc when no row but rpc has it', () => {
    expect(resolveTxViewKind(null, { hash: '0xabc' })).toBe('rpc')
  })
  it('missing when neither', () => {
    expect(resolveTxViewKind(null, null)).toBe('missing')
  })
  it('treats null/undefined bodyPruned as local (pre-migration rows)', () => {
    expect(resolveTxViewKind({}, null)).toBe('local')
    expect(resolveTxViewKind({ bodyPruned: null }, null)).toBe('local')
  })
})

// rpc-fallback has nothing to read `status` from while a tx has no receipt, so it defaults it to
// true. That default is not a result: a pending tx must not be reported as having succeeded.
describe('txOutcome', () => {
  it('a mined tx is its receipt status', () => {
    expect(txOutcome({ status: true })).toBe('success')
    expect(txOutcome({ status: false })).toBe('failed')
    expect(txOutcome({ status: true, pending: false })).toBe('success')
    expect(txOutcome({ status: false, pending: false })).toBe('failed')
  })

  it('a tx with no receipt is pending, whatever its defaulted status says', () => {
    expect(txOutcome({ status: true, pending: true })).toBe('pending')
    expect(txOutcome({ status: false, pending: true })).toBe('pending')
  })
})

// A token-transfer row decoded from transfer(address,uint256) calldata is a claim about what happened, but
// calldata is only what was asked. A reverted call moved nothing, a pending one has not run, and a
// receipt that was READ and held no Transfer log says no ERC-20 moved (the call may not even be a
// token's). Only a succeeded tx whose logs could not be read leaves the calldata as the best evidence.
describe('mayShowCalldataTransfer', () => {
  const ok = { methodId: '0xa9059cbb', outcome: 'success' as const, logsUnavailable: true, knownTransfers: 0 }

  it('allows a succeeded transfer() whose logs could not be read and which has no transfers', () => {
    expect(mayShowCalldataTransfer(ok)).toBe(true)
  })

  it('never for a failed or a pending tx', () => {
    expect(mayShowCalldataTransfer({ ...ok, outcome: 'failed' })).toBe(false)
    expect(mayShowCalldataTransfer({ ...ok, outcome: 'pending' })).toBe(false)
  })

  it('never when the logs were read (an empty receipt is an answer, not an unknown)', () => {
    expect(mayShowCalldataTransfer({ ...ok, logsUnavailable: false })).toBe(false)
  })

  it('never when real transfers are already known', () => {
    expect(mayShowCalldataTransfer({ ...ok, knownTransfers: 1 })).toBe(false)
  })

  it('only for transfer(address,uint256)', () => {
    expect(mayShowCalldataTransfer({ ...ok, methodId: '0x23b872dd' })).toBe(false)
    expect(mayShowCalldataTransfer({ ...ok, methodId: null })).toBe(false)
  })
})

// The page only has TODAY's native price, so a USD figure beside a transaction from last month is not what
// it was worth then. The figure is kept (it is useful) but must say which price it is.
describe('atCurrentPrice', () => {
  it('words a USD figure as at the current price, not the price at the time of the tx', () => {
    expect(atCurrentPrice('$12.34')).toBe('$12.34 at current price')
    expect(atCurrentPrice('< $0.01')).toBe('< $0.01 at current price')
  })
})

// The indexer keeps only the first 500 characters of a transaction's input ('0x' + 249 bytes) and leaves
// body_pruned false. The page and the API then handed that prefix out as the whole input.
describe('inputMayBeTruncated', () => {
  const hex = (chars: number) => '0x' + 'ab'.repeat(chars).slice(0, chars - 2)

  it('is true from the indexer cut-off up: 500 characters may be a cut or a coincidentally exact input', () => {
    expect(STORED_INPUT_CHARS).toBe(500)
    expect(STORED_INPUT_BYTES).toBe(249)
    expect(inputMayBeTruncated(hex(500))).toBe(true)
    expect(inputMayBeTruncated(hex(501))).toBe(true)
  })

  it('is false for anything the indexer stores whole', () => {
    expect(inputMayBeTruncated(hex(499))).toBe(false)
    expect(inputMayBeTruncated('0x')).toBe(false)
    expect(inputMayBeTruncated('')).toBe(false)
    expect(inputMayBeTruncated(null)).toBe(false)
    expect(inputMayBeTruncated(undefined)).toBe(false)
  })
})

describe('TRUNCATED_INPUT_NOTE', () => {
  it('says how much is stored and that the rest is unavailable', () => {
    expect(TRUNCATED_INPUT_NOTE).toContain('first 249 bytes')
    expect(TRUNCATED_INPUT_NOTE).toContain('unavailable')
  })
})

describe('needsInputRefetch', () => {
  const cut = '0x' + 'ab'.repeat(249)

  it('refetches only for an indexed tx whose stored input may be cut', () => {
    expect(needsInputRefetch('local', cut)).toBe(true)
    expect(needsInputRefetch('local', '0xa9059cbb')).toBe(false)
  })

  it('leaves the views that already read the whole input from the node alone', () => {
    expect(needsInputRefetch('pruned', cut)).toBe(false)   // body refetch already supplies input + logs
    expect(needsInputRefetch('rpc', cut)).toBe(false)      // the node's own answer is whole
    expect(needsInputRefetch('missing', cut)).toBe(false)
  })
})

describe('resolveStoredInput', () => {
  const stored = '0x' + 'ab'.repeat(249)
  const full = stored + 'cd'.repeat(300)

  it('uses the fetched full input in place of the cut one', () => {
    expect(resolveStoredInput(stored, full)).toEqual({ input: full, truncated: false })
  })

  it('keeps the stored prefix and says so when the full input could not be fetched', () => {
    expect(resolveStoredInput(stored, null)).toEqual({ input: stored, truncated: true })
    expect(resolveStoredInput(stored, undefined)).toEqual({ input: stored, truncated: true })
  })

  it('does not trust a fetched input that is not an extension of what was stored', () => {
    expect(resolveStoredInput(stored, '0x' + 'ff'.repeat(400))).toEqual({ input: stored, truncated: true })
    expect(resolveStoredInput(stored, '0x1234')).toEqual({ input: stored, truncated: true })
  })

  it('matches the prefix whatever the hex letter case', () => {
    expect(resolveStoredInput(stored.toUpperCase().replace('0X', '0x'), full)).toEqual({ input: full, truncated: false })
  })

  it('an input stored whole needs nothing, and is never called truncated', () => {
    expect(resolveStoredInput('0xa9059cbb', null)).toEqual({ input: '0xa9059cbb', truncated: false })
    expect(resolveStoredInput('0x', null)).toEqual({ input: '0x', truncated: false })
    expect(resolveStoredInput(null, null)).toEqual({ input: '0x', truncated: false })
  })
})
