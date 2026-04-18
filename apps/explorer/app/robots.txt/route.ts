import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// Aggressive AI crawlers — we block them from heavy list/detail paths to protect
// the DB pool. Mirrors the UA list in apps/explorer/middleware.ts which returns
// 429 on these paths. robots.txt is the polite signal; the middleware is the fence.
const AI_BOTS_HEAVY_BLOCK = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'Amazonbot',
  'Bytespider',
  'CCBot',
  'cohere-ai',
  'Diffbot',
  'FacebookBot',
  'meta-externalagent',
  'ImagesiftBot',
  'omgilibot',
  'YouBot',
]

const HEAVY_PATHS = ['/blocks', '/txs', '/tx/', '/address/', '/token/', '/block/']

export async function GET() {
  const BASE = `https://${chainConfig.domain}`

  const lines: string[] = []

  lines.push('# Human-readable policy: block AI crawlers from heavy DB-backed pages.')
  lines.push('# See Content-Signal below for AI content-usage preferences.')
  lines.push('')

  lines.push('User-agent: *')
  lines.push('Allow: /')
  lines.push('Disallow: /address/')
  lines.push('Disallow: /api/')
  lines.push('')

  for (const bot of AI_BOTS_HEAVY_BLOCK) {
    lines.push(`User-agent: ${bot}`)
    for (const p of HEAVY_PATHS) lines.push(`Disallow: ${p}`)
    lines.push('')
  }

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
