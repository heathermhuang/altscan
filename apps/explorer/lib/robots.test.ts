import { describe, it, expect } from 'vitest'
import { GET } from '@/app/robots.txt/route'

describe('robots.txt', () => {
  it('keeps crawlers off the noindex pages of a block\'s transactions, in the catch-all group', async () => {
    const lines = (await (await GET()).text()).split('\n')
    const star = lines.indexOf('User-agent: *')
    const end = lines.indexOf('', star)
    expect(star).toBeGreaterThanOrEqual(0)
    expect(lines.slice(star, end)).toContain('Disallow: /blocks/*/txs/')
  })
})
