import { describe, expect, it } from 'vitest'
import { resolveTxCount } from './address-tx-count'

describe('resolveTxCount', () => {
  it('uses the indexed count and ignores the nonce when the index has one', () => {
    expect(resolveTxCount({ indexed: 1234, nonce: 500 })).toEqual({ total: 1234, known: true, text: '1,234', nonceNote: null })
  })

  it('never turns the outgoing-only nonce into the total: nonce 500 with indexed 0 is not "500 transactions"', () => {
    const r = resolveTxCount({ indexed: 0, nonce: 500 })
    expect(r.total).toBe(0)
    expect(r.known).toBe(false)
    expect(r.text).toBe('—')
    expect(r.nonceNote).toBe('500 sent (nonce)')
  })

  it('treats a missing row (or a failed read) as unknown, and labels the nonce', () => {
    expect(resolveTxCount({ indexed: null, nonce: 500 })).toEqual({ total: 0, known: false, text: '—', nonceNote: '500 sent (nonce)' })
    expect(resolveTxCount({ indexed: undefined, nonce: null })).toEqual({ total: 0, known: false, text: '—', nonceNote: null })
  })

  it('keeps a real zero when the chain shows no sends either', () => {
    expect(resolveTxCount({ indexed: 0, nonce: 0 })).toEqual({ total: 0, known: true, text: '0', nonceNote: null })
    expect(resolveTxCount({ indexed: 0, nonce: null })).toEqual({ total: 0, known: true, text: '0', nonceNote: null })
  })
})
