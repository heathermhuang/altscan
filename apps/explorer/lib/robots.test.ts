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

  // A Content-Signal belongs to the group it sits in. Placed after the
  // training-bot group it governed only those bots, and search engines and
  // retrieval agents under `*` got no signal at all.
  it('declares the Content-Signal policy in the catch-all group, and only there', async () => {
    const lines = (await (await GET()).text()).split('\n')
    const star = lines.indexOf('User-agent: *')
    const end = lines.indexOf('', star)
    expect(lines.slice(star, end)).toContain('Content-Signal: ai-train=no, search=yes, ai-input=yes')
    expect(lines.filter(l => l.startsWith('Content-Signal:'))).toHaveLength(1)
  })
})
