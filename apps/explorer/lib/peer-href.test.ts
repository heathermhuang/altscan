import { describe, expect, it } from 'vitest'
import { peerHref } from './peer-href'

const PEER = 'https://ethscan.io'

describe('peerHref', () => {
  it('sends a token page to the peer home: the address is another object there', () => {
    expect(peerHref(PEER, '/token/0x55d398326f99059fF775485246999027B3197955')).toBe('https://ethscan.io/')
  })

  it.each(['/address/0x55d398326f99059fF775485246999027B3197955', '/tx/0xabc', '/blocks/123', '/blocks/123/txs/2'])(
    'sends the dynamic route %s to the peer home',
    (path) => {
      expect(peerHref(PEER, path)).toBe('https://ethscan.io/')
    },
  )

  it.each(['/validators', '/staking', '/search'])('sends %s (one chain only, or needs its query) to the peer home', (path) => {
    expect(peerHref(PEER, path)).toBe('https://ethscan.io/')
  })

  it.each(['/', '/txs', '/blocks', '/gas', '/dex', '/whales', '/charts', '/token', '/api-docs', '/developer'])(
    'keeps the static route %s',
    (path) => {
      expect(peerHref(PEER, path)).toBe(`https://ethscan.io${path}`)
    },
  )

  it('ignores a trailing slash on either side and a missing pathname', () => {
    expect(peerHref('https://ethscan.io/', '/gas/')).toBe('https://ethscan.io/gas')
    expect(peerHref(PEER, null)).toBe('https://ethscan.io/')
    expect(peerHref(PEER, undefined)).toBe('https://ethscan.io/')
  })

  it('does not match on a prefix: /gasx and /token-list are not /gas and /token', () => {
    expect(peerHref(PEER, '/gasx')).toBe('https://ethscan.io/')
    expect(peerHref(PEER, '/token-list')).toBe('https://ethscan.io/')
  })
})
