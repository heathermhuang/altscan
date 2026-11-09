import { NextResponse } from 'next/server'
import { checkRateLimit, clientIpBucket } from '@/lib/api-rate-limit'
import { withClientAdmission } from '@altscan/providers'

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
  // Namespaced bucket so it doesn't collide with the /api/v1 IP limiter.
  if (!(await checkRateLimit(`internal:${clientIpBucket(req.headers)}`, maxPerMin))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers })
  }
  return null
}

/**
 * Billed provider calls per client (IP bucket) per hour. The request limit above counts requests, and a cached answer
 * costs nothing, so it cannot tell a client browsing a few addresses from one walking thousands of uncached ones and
 * spending the fleet's shared allowance (BNB's whole month is 250k CU). This counts only the calls that reach the
 * provider (packages/providers client-admission.ts); past it, that client's tabs show the local index.
 */
export const PROVIDER_CALLS_PER_CLIENT_PER_HOUR = (() => {
  const n = Number(process.env.PROVIDER_CALLS_PER_CLIENT_PER_HOUR)
  return Number.isInteger(n) && n > 0 ? n : 60
})()

/** Run a provider call charged to this request's client, only if it is billed. */
export function asClient<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const bucket = `prov:${clientIpBucket(req.headers)}`
  return withClientAdmission(() => checkRateLimit(bucket, PROVIDER_CALLS_PER_CLIENT_PER_HOUR, 60 * 60 * 1000), fn)
}
