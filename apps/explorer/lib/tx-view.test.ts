import { describe, expect, it } from 'vitest'
import { resolveTxViewKind } from './tx-view'

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
