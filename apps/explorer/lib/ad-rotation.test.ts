import { describe, expect, it } from 'vitest'
import { pickWeighted } from './ad-rotation'

const A = { id: 'a', weight: 1 }
const B = { id: 'b', weight: 3 }

describe('pickWeighted', () => {
  it('returns null for an empty list', () => {
    expect(pickWeighted([], 0.5)).toBeNull()
  })

  it('always returns the only candidate', () => {
    for (const roll of [0, 0.25, 0.999999]) {
      expect(pickWeighted([A], roll)).toBe(A)
    }
  })

  it('splits the range by cumulative weight', () => {
    // total = 4; A owns [0, 0.25), B owns [0.25, 1)
    expect(pickWeighted([A, B], 0)).toBe(A)
    expect(pickWeighted([A, B], 0.2499)).toBe(A)
    expect(pickWeighted([A, B], 0.25)).toBe(B)
    expect(pickWeighted([A, B], 0.999999)).toBe(B)
  })

  it('clamps out-of-range rolls instead of returning null', () => {
    expect(pickWeighted([A, B], -1)).toBe(A)
    expect(pickWeighted([A, B], 1)).toBe(B)
    expect(pickWeighted([A, B], Number.NaN)).toBe(A)
  })

  it('skews to the heavy candidate over many rolls', () => {
    const counts = { a: 0, b: 0 }
    for (let i = 0; i < 1000; i++) {
      const picked = pickWeighted([A, B], i / 1000)
      counts[picked!.id as 'a' | 'b']++
    }
    expect(counts.a).toBe(250)
    expect(counts.b).toBe(750)
  })
})
