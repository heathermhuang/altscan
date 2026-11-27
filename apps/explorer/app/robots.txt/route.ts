import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'
import { CRAWL_DELAYED, TRAINING_BLOCKED } from '@/lib/bot-policy'

// Bot policy lives in lib/bot-policy.ts (shared with middleware.ts, which
// enforces the same list with HTTP 429 — robots.txt is the polite signal,
// the middleware is the fence).

export async function GET() {
  const BASE = `https://${chainConfig.domain}`

  const lines: string[] = []

  lines.push('# Policy: search engines and AI retrieval/citation agents are welcome.')
  lines.push('# AI training / bulk-corpus crawlers are blocked (and rate-limited).')
  lines.push('# Machine-readable AI usage preferences: see Content-Signal below.')
  lines.push('')

  // Content Signals (https://contentsignals.org/) — declare AI content-usage policy.
  // Like any robots.txt rule it belongs to the group it sits in, so it must stay
  // inside every group that allows crawling: after the training-bot group it applied
  // only to those (already disallowed) bots and left everyone else with no signal.
  // ai-train=no   → do not use content to train models
  // search=yes    → allow indexing for search features
  // ai-input=yes  → allow retrieval-augmented answers (agents quoting public chain data)
  const allowRules = [
    'Content-Signal: ai-train=no, search=yes, ai-input=yes',
    'Allow: /',
    'Disallow: /address/',
    // Noindex pages of a block's transactions: crawling them multiplies block renders for nothing.
    'Disallow: /blocks/*/txs/',
    'Disallow: /api/',
  ]

  lines.push('User-agent: *')
  lines.push(...allowRules)
  lines.push('')

  // A UA with a group of its own ignores `User-agent: *`, so each throttled
  // group repeats the catch-all rules alongside its Crawl-delay.
  for (const [bot, seconds] of Object.entries(CRAWL_DELAYED)) {
    lines.push(`User-agent: ${bot}`)
    lines.push(`Crawl-delay: ${seconds}`)
    lines.push(...allowRules)
    lines.push('')
  }

  // One shared group — every User-agent line above a rule block shares it.
  // Retrieval/search agents (OAI-SearchBot, ChatGPT-User, Claude-User,
  // PerplexityBot, …) deliberately get NO group of their own, CRAWL_DELAYED
  // aside: under REP a UA without a matching group inherits `User-agent: *` above.
  lines.push('# AI training / bulk-scrape crawlers — blocked site-wide:')
  for (const bot of TRAINING_BLOCKED) lines.push(`User-agent: ${bot}`)
  lines.push('Disallow: /')
  lines.push('')

  lines.push(`Sitemap: ${BASE}/sitemap.xml`)
  lines.push('')

  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
