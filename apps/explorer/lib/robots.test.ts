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
  it('declares the Content-Signal policy in the catch-all group, and not for training bots', async () => {
    const lines = (await (await GET()).text()).split('\n')
    const star = lines.indexOf('User-agent: *')
    const end = lines.indexOf('', star)
    expect(lines.slice(star, end)).toContain('Content-Signal: ai-train=no, search=yes, ai-input=yes')
    const training = lines.indexOf('User-agent: GPTBot')
    expect(lines.slice(training, lines.indexOf('', training)).some(l => l.startsWith('Content-Signal:'))).toBe(false)
  })

  // A UA with its own group ignores `*` entirely, so the throttled group must
  // carry every catch-all rule or Claude-SearchBot would lose /address/ etc.
  it('slows Claude-SearchBot with a Crawl-delay while keeping every catch-all rule', async () => {
    const lines = (await (await GET()).text()).split('\n')
    const group = (ua: string) => {
      const i = lines.indexOf(`User-agent: ${ua}`)
      expect(i, ua).toBeGreaterThanOrEqual(0)
      return lines.slice(i + 1, lines.indexOf('', i))
    }
    const csb = group('Claude-SearchBot')
    expect(csb).toContain('Crawl-delay: 2')
    expect(csb.filter(l => !l.startsWith('Crawl-delay:'))).toEqual(group('*'))
    expect(group('*').some(l => l.startsWith('Crawl-delay:'))).toBe(false)
  })
})
