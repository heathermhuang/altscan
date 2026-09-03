import { describe, it, expect } from 'vitest'
import { getLabelForChain, BNB_ADDRESSES, ETH_ADDRESSES, SHARED_ADDRESSES } from './known-addresses'

describe('getLabelForChain', () => {
  it('resolves a BSC label on bnb', () => {
    expect(getLabelForChain('bnb', '0x10ed43c718714eb63d5aa57b78b54704e256024e'))
      .toEqual({ label: 'PancakeSwap: Router v2', category: 'defi' })
  })

  it('resolves an Ethereum label on eth', () => {
    expect(getLabelForChain('eth', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'))
      .toEqual({ label: 'Wrapped Ether', category: 'token' })
  })

  it('is case-insensitive about the queried address', () => {
    expect(getLabelForChain('eth', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')?.label)
      .toBe('Wrapped Ether')
  })

  // The bug this table had in production. Both of these are BSC token contracts
  // that were being labelled on ethscan.io too, because there was one flat map
  // and no chain dimension at all:
  //   0x2170ed08… is a live, unrelated Ethereum address holding 217 ETH.
  //   0x55d39832… is flagged "Blocked — Phish / Hack" on Ethereum.
  // Labelling a flagged phishing address "USDT (BSC)" is worse than no label.
  it('never resolves a BSC-only label on eth', () => {
    for (const addr of Object.keys(BNB_ADDRESSES)) {
      if (addr in SHARED_ADDRESSES) continue
      expect(getLabelForChain('eth', addr), `${addr} leaked onto eth`).toBeNull()
    }
  })

  it('never resolves an Ethereum-only label on bnb', () => {
    for (const addr of Object.keys(ETH_ADDRESSES)) {
      if (addr in SHARED_ADDRESSES) continue
      expect(getLabelForChain('bnb', addr), `${addr} leaked onto bnb`).toBeNull()
    }
  })

  it('resolves chain-agnostic burn addresses on both chains', () => {
    for (const addr of Object.keys(SHARED_ADDRESSES)) {
      expect(getLabelForChain('bnb', addr)).not.toBeNull()
      expect(getLabelForChain('eth', addr)).not.toBeNull()
    }
  })

  it('returns null for an unknown address', () => {
    expect(getLabelForChain('eth', '0x1234567890123456789012345678901234567890')).toBeNull()
  })

  // Every key is used as a lowercase lookup key; a stray uppercase entry would
  // be permanently unreachable and silently do nothing.
  it('stores every key lowercased and well-formed', () => {
    for (const table of [BNB_ADDRESSES, ETH_ADDRESSES, SHARED_ADDRESSES]) {
      for (const addr of Object.keys(table)) {
        expect(addr).toBe(addr.toLowerCase())
        expect(addr).toMatch(/^0x[0-9a-f]{40}$/)
      }
    }
  })
})
