/**
 * The explorer's OAuth code store against a REAL Redis: its single-use guarantee is a Lua script,
 * and a JS stand-in would only test the stand-in.
 *
 * GATED: set OAUTH_TEST_REDIS_URL to run. Locally:
 *   redis-server --port 6399 --save '' --appendonly no --daemonize yes
 *   OAUTH_TEST_REDIS_URL=redis://127.0.0.1:6399 npx vitest run apps/explorer/lib/oauth-codes.redis.test.ts
 *
 * It writes only `oauth:code:<random>` keys with a short TTL, and never flushes anything.
 */
import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CodeGrant } from '@altscan/oauth'
import { oauthConfig } from '@/lib/oauth'

const URL_ = process.env.OAUTH_TEST_REDIS_URL
const d = URL_ ? describe : describe.skip

const grant: CodeGrant = {
  iss: 'https://bnbscan.com', client_id: 'ac1.x', redirect_uri: 'https://client.example/cb', code_challenge: 'c'.repeat(43), scope: 'api', sub: '0x' + '12'.repeat(20),
}
const code = () => randomBytes(16).toString('hex')

d('OAuth codes in Redis', () => {
  beforeAll(() => {
    vi.stubEnv('REDIS_URL', URL_!) // read by explorer-core's getRedis on first use
    vi.stubEnv('OAUTH_SECRET', 'z'.repeat(64))
  })
  const codes = () => oauthConfig()!.codes

  it('returns a code once', async () => {
    const c = code()
    await codes().put(c, grant, 60)
    expect(await codes().take(c)).toEqual(grant)
    expect(await codes().take(c)).toBeNull()
  })

  it('gives a code to exactly one of many concurrent takers', async () => {
    const c = code()
    await codes().put(c, grant, 60)
    const results = await Promise.all(Array.from({ length: 20 }, () => codes().take(c)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('forgets a code after its TTL', async () => {
    const c = code()
    await codes().put(c, grant, 1)
    await new Promise((r) => setTimeout(r, 1100))
    expect(await codes().take(c)).toBeNull()
  })
})
