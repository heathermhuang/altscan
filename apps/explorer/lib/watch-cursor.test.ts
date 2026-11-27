import { describe, expect, it } from 'vitest'
import { END_OF_BLOCK, decodeWatchCursor, encodeWatchCursor, type WatchCursor } from './watch-cursor'

const H = '0x' + 'ab'.repeat(32)
const W = '0x' + 'cd'.repeat(20)
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

describe('watch cursor', () => {
  it('accepts the largest int4 index', () => {
    expect(decodeWatchCursor(enc([1, H, 0, 2147483647, W]))?.i).toBe(2147483647)
  })

  it('round-trips an event position and an end-of-block position', () => {
    const at: WatchCursor = { b: 12345678, h: H, k: 1, i: 4, w: W }
    const end: WatchCursor = { b: 12345678, h: H, k: END_OF_BLOCK, i: 0, w: '' }
    expect(decodeWatchCursor(encodeWatchCursor(at))).toEqual(at)
    expect(decodeWatchCursor(encodeWatchCursor(end))).toEqual(end)
  })

  it.each([
    ['not base64 JSON', '!!!'],
    ['wrong arity', enc([1, H, 0, 0])],
    ['negative block', enc([-1, H, 0, 0, W])],
    ['fractional block', enc([1.5, H, 0, 0, W])],
    ['bad hash', enc([1, '0x12', 0, 0, W])],
    ['unknown kind', enc([1, H, 3, 0, W])],
    ['negative index', enc([1, H, 0, -1, W])],
    ['index past int4', enc([1, H, 0, 2147483648, W])],
    ['bad watched address', enc([1, H, 0, 0, '0xzz'])],
    ['oversized', 'a'.repeat(513)],
  ])('refuses %s', (_, s) => {
    expect(decodeWatchCursor(s)).toBeNull()
  })
})
