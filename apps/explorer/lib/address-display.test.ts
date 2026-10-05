import { describe, it, expect } from 'vitest'
import { toChecksumAddress, shortenAddress, shortHash } from './address-display'

describe('toChecksumAddress', () => {
  // Vectors from EIP-55 itself. These are the contract: a wallet that
  // validates a pasted address checks exactly these mixed-case forms.
  it('matches the EIP-55 reference vectors', () => {
    const vectors = [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
      '0x52908400098527886E0F7030069857D2E4169EE7',
      '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
      '0xde709f2102306220921060314715629080e2fb77',
      '0x27b1fdb04752bbc536007a920d24acb045561c26',
    ]
    for (const v of vectors) {
      expect(toChecksumAddress(v.toLowerCase())).toBe(v)
      expect(toChecksumAddress(v)).toBe(v)
    }
  })

  it('normalizes an already-checksummed address idempotently', () => {
    const a = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    expect(toChecksumAddress(toChecksumAddress(a))).toBe(a)
  })

  // Every caller is a render path. Throwing here would 500 a whole page over
  // one malformed row, so bad input must pass through untouched instead.
  it('returns the input unchanged rather than throwing on malformed input', () => {
    expect(toChecksumAddress('not-an-address')).toBe('not-an-address')
    expect(toChecksumAddress('0x123')).toBe('0x123')
    expect(toChecksumAddress('')).toBe('')
    expect(toChecksumAddress(null as unknown as string)).toBe('')
    expect(toChecksumAddress(undefined as unknown as string)).toBe('')
  })

  it('rejects a wrong-checksum address by re-deriving rather than trusting it', () => {
    const correct = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    // MIXED case with a deliberately wrong checksum (final d -> D). This is the
    // only input shape that pins the re-derivation: ethers treats an all-upper
    // or all-lower address as "no checksum supplied" and computes one anyway,
    // so those cases pass even if we hand the caller's casing straight through.
    // Mutation-tested: dropping the .toLowerCase() must fail THIS assertion.
    expect(toChecksumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(correct)
    // All-caps and all-lower must still resolve, for completeness.
    expect(toChecksumAddress('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED')).toBe(correct)
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(correct)
  })
})

describe('shortenAddress', () => {
  it('shortens while preserving EIP-55 casing', () => {
    expect(shortenAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe('0x5aAeb6…BeAed')
  })

  it('leaves malformed input alone instead of slicing garbage', () => {
    expect(shortenAddress('0x123')).toBe('0x123')
  })
})

describe('shortHash', () => {
  const H = '0xA0188FDE5D8C1B8E2C2D5F8E9A6B3C4D7E8F9A0B1C2D3E4F5A6B7C8D9E0F8946'

  it('is 0x + 6 hex, an ellipsis, then 5 hex, lowercase, matching shortenAddress shape', () => {
    expect(shortHash(H)).toBe('0xa0188f…f8946')
    expect(shortHash(H.toLowerCase())).toBe('0xa0188f…f8946')
    // same lead/tail counts as the address helper, so the two read alike
    const a = shortenAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')
    expect(a.indexOf('…')).toBe(shortHash(H).indexOf('…'))
    expect(a.length).toBe(shortHash(H).length)
  })

  it('never uses three dots', () => {
    expect(shortHash(H)).not.toContain('...')
  })

  it('leaves malformed input whole rather than slicing garbage', () => {
    expect(shortHash('0x123')).toBe('0x123')
    expect(shortHash('')).toBe('')
    expect(shortHash(null as unknown as string)).toBe('')
    // a 40-hex address is not a hash
    expect(shortHash('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')
  })
})
