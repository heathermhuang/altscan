import { describe, expect, it } from 'vitest'
import { clipText } from '@/lib/clip-text'

describe('clipText', () => {
  it('leaves text that fits, and cuts the rest to exactly n characters with an ellipsis', () => {
    expect(clipText('USDT', 14)).toBe('USDT')
    expect(clipText('A'.repeat(14), 14)).toBe('A'.repeat(14))
    expect(clipText('A'.repeat(15), 14)).toBe(`${'A'.repeat(13)}…`)
  })

  it('cuts on characters, never through an emoji (a lone surrogate would print as a broken glyph)', () => {
    expect(clipText('ab🐵🐵🐵', 4)).toBe('ab🐵…')
    expect(clipText('🐵'.repeat(10), 3)).toBe('🐵🐵…')
  })
})
