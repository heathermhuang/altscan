import { describe, expect, it } from 'vitest'
import { atCurrentPrice, mayShowCalldataTransfer, resolveTxViewKind, txOutcome } from './tx-view'

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
