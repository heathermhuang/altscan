import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'
import { TRAINING_BLOCKED } from '@/lib/bot-policy'

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

  lines.push('User-agent: *')
  lines.push('Allow: /')
  lines.push('Disallow: /address/')
  lines.push('Disallow: /api/')
  lines.push('')

  // One shared group — every User-agent line above a rule block shares it.
  // Retrieval/search agents (OAI-SearchBot, ChatGPT-User, Claude-User,
  // PerplexityBot, …) deliberately get NO group of their own: under REP a UA
  // without a matching group inherits `User-agent: *` above.
  lines.push('# AI training / bulk-scrape crawlers — blocked site-wide:')
  for (const bot of TRAINING_BLOCKED) lines.push(`User-agent: ${bot}`)
  lines.push('Disallow: /')
  lines.push('')

  // Content Signals (https://contentsignals.org/) — declare AI content-usage policy.
  // ai-train=no   → do not use content to train models
  // search=yes    → allow indexing for search features
  // ai-input=yes  → allow retrieval-augmented answers (agents quoting public chain data)
  lines.push('# Content Signals (https://contentsignals.org/)')
  lines.push('Content-Signal: ai-train=no, search=yes, ai-input=yes')
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
