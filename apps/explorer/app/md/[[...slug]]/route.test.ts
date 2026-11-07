import { describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// Only paths that never reach the database are exercised (unsupported, malformed ids).
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))

import { GET } from '@/app/md/[[...slug]]/route'

// The markdown is read by agents. The path arrives percent-decoded, so %60 is a backtick and %0A a
// newline: echoed raw, they close the code span and add headings, links or instructions of the
// caller's choosing.
const HOSTILE = 'x`\n\n# Injected heading\n[click](https://evil.example/)'

async function md(...slug: string[]) {
  const res = await GET({} as NextRequest, { params: Promise.resolve({ slug }) })
  return { status: res.status, body: await res.text() }
}

describe('/md does not echo hostile path text', () => {
  it.each([
    ['an unsupported path', ['nope', HOSTILE]],
    ['a malformed tx hash', ['tx', HOSTILE]],
    ['a malformed block number', ['blocks', HOSTILE]],
    ['a malformed block number on /block/', ['block', HOSTILE]],
  ])('%s', async (_label, slug) => {
    const { body } = await md(...slug)
    expect(body).not.toContain('Injected')
    expect(body).not.toContain('evil.example')
    expect(body).not.toContain('`\n')
    // The only headings are the route's own.
    expect(body.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(1)
  })

  it('a backtick alone, with no newline, cannot break out of the code span either', async () => {
    const { status, body } = await md('tx', 'abc`def')
    expect(status).toBe(404)
    expect(body).not.toContain('abc`def')
  })

  it('an over-long value is not echoed', async () => {
    const { body } = await md('tx', 'a'.repeat(201))
    expect(body).not.toContain('a'.repeat(50))
  })

  it('keeps the statuses: 404 for a malformed id, 406 for an unsupported path', async () => {
    expect((await md('tx', 'abc`def')).status).toBe(404)
    expect((await md('blocks', 'abc`def')).status).toBe(404)
    // A newline defeats the routes' `(.+)` match, so that path was always "unsupported".
    expect((await md('tx', HOSTILE)).status).toBe(406)
    expect((await md('nope', HOSTILE)).status).toBe(406)
  })
})

describe('/md still echoes plain paths', () => {
  it('an unsupported path', async () => {
    const { status, body } = await md('some', 'path-1', 'a_b.c')
    expect(status).toBe(406)
    expect(body).toContain('`/some/path-1/a_b.c`')
  })

  it('a malformed tx hash and block number', async () => {
    expect((await md('tx', '0xabc')).body).toContain('`0xabc` is not in the')
    expect((await md('blocks', 'latest')).body).toContain('`latest` is not in the')
  })
})

describe('/md/api-docs', () => {
  // It once said every documented endpoint needs no authentication; webhooks and key management do.
  it('names the endpoints that take a key and points to auth.md', async () => {
    const { body } = await md('api-docs')
    expect(body).not.toMatch(/require no authentication/)
    expect(body).toContain('`/api/v1/webhooks`')
    expect(body).toMatch(/https:\/\/[^ ]+\/auth\.md/)
  })
})

describe('/md cache headers', () => {
  // The middleware answers a markdown request to a page URL (/tx/…, /about, …) by rewriting it to
  // /md/_negotiated/…. That answer is served at the page's own URL, and Cloudflare's cache ignores
  // Vary: Accept, so it must never be shared-cacheable: one request could replace the page for every
  // visitor. A direct /md/… URL is its own URL and keeps its public caching.
  const headers = async (...slug: string[]) => {
    const res = await GET({} as NextRequest, { params: Promise.resolve({ slug }) })
    return { cache: res.headers.get('cache-control'), status: res.status, body: await res.text() }
  }

  it('a direct /md URL is publicly cacheable', async () => {
    expect((await headers('about')).cache).toBe('public, max-age=3600')
  })

  it.each([['about'], ['api-docs'], [], ['tx', '0xabc'], ['nope']])('the negotiated answer for %j is private and otherwise identical', async (...slug) => {
    const direct = await headers(...slug)
    const negotiated = await headers('_negotiated', ...slug)
    expect(negotiated.cache).toBe('private, no-store')
    expect({ status: negotiated.status, body: negotiated.body }).toEqual({ status: direct.status, body: direct.body })
  })
})
