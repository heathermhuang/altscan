import { NextResponse } from 'next/server'
import { checkRateLimit, extractClientIp } from '@/lib/api-rate-limit'

const ADDR = /^0x[0-9a-fA-F]{40}$/

/**
 * Guard for the unauthenticated /api/internal/* Moralis-proxy routes.
 *
 * These routes share ONE global, fleet-wide Moralis budget. Without a per-client
 * limit, a single caller requesting many distinct (uncached) addresses drains
 * the shared buckets and degrades every real user's history/holders/NFT tabs to
 * the local fallback. So: reject malformed addresses before spending a bucket
 * slot, and rate-limit per client IP (30/min is generous for a human clicking
 * through an address's tabs; abusive fan-out across many addresses is capped).
 *
 * Returns an error Response to short-circuit, or null when the request may proceed.
 */
export async function guardInternalAddress(
  req: Request,
  address: string,
  maxPerMin = 30,
): Promise<NextResponse | null> {
  const headers = { 'cache-control': 'private, no-store' }
  if (!ADDR.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400, headers })
  }
  // Prefer Cloudflare's client IP (bnbscan.com/ethscan.io sit behind CF); fall
  // back to the last X-Forwarded-For hop (what Render's LB appends). Namespaced
  // bucket so it doesn't collide with the /api/v1 IP limiter.
  const ip =
    req.headers.get('cf-connecting-ip')?.trim() ||
    extractClientIp(req.headers.get('x-forwarded-for'))
  if (!(await checkRateLimit(`internal:${ip}`, maxPerMin))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers })
  }
  return null
}
