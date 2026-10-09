import { describe, expect, it } from 'vitest'
import { resolveTxViewKind, txOutcome } from './tx-view'

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
