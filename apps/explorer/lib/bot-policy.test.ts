import { describe, expect, it } from 'vitest'
import { RETRIEVAL_ALLOWED, TRAINING_BLOCKED, isTrainingBot } from './bot-policy'

// Real-world UA strings for the allowed tier (from vendor docs). These must
// NEVER be throttled: isTrainingBot does substring matching, which is
// collision-prone (a hypothetical needle "GPT" would catch ChatGPT-User).
const ALLOWED_UAS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
  'Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko; compatible; Applebot/0.1; +http://www.apple.com/go/applebot)',
  'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)',
  // link-preview fetcher — throttling it broke WhatsApp/FB/Messenger unfurls
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  // classic search engines — governed by robots `User-agent: *`, never throttled
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
]

const TRAINING_UAS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'CCBot/2.0 (https://commoncrawl.org/faq/)',
  'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
  'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  'Mozilla/5.0 (compatible; FacebookBot/1.0; +https://developers.facebook.com/docs/sharing/webmasters/facebookbot)',
]

describe('bot-policy', () => {
  it('never classifies allowed retrieval/search/preview UAs as training bots', () => {
    for (const ua of ALLOWED_UAS) expect(isTrainingBot(ua), ua).toBe(false)
  })

  it('classifies training-crawler UAs as training bots', () => {
    for (const ua of TRAINING_UAS) expect(isTrainingBot(ua), ua).toBe(true)
  })

  it('keeps the tiers disjoint — no RETRIEVAL_ALLOWED token matches a TRAINING_BLOCKED needle', () => {
    for (const allowed of RETRIEVAL_ALLOWED) {
      expect(isTrainingBot(allowed), allowed).toBe(false)
    }
  })

  it('no TRAINING_BLOCKED needle is a substring of another (redundant entries hide policy drift)', () => {
    const lower = TRAINING_BLOCKED.map((b) => b.toLowerCase())
    for (const a of lower) {
      for (const b of lower) {
        if (a !== b) expect(b.includes(a), `${a} ⊂ ${b}`).toBe(false)
      }
    }
  })

  it('treats missing UA as not-a-training-bot', () => {
    expect(isTrainingBot(null)).toBe(false)
    expect(isTrainingBot('')).toBe(false)
  })
})
