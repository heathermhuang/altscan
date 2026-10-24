/**
 * The developer page publishes a webhook payload sample and a signature
 * verification sample. Both are a contract with consumers, so this runs them
 * against what the indexer actually sends: the real notifyWebhooks, with its
 * database and network faked.
 *
 * The verification sample used to HMAC with the raw secret while delivery signs
 * with its sha256, so anyone copying it could never verify a real delivery.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const RAW_SECRET = 'a'.repeat(64) // what POST /api/v1/webhooks returns once
const STORED = crypto.createHash('sha256').update(RAW_SECRET).digest('hex') // what it stores

vi.mock('../../indexer/src/db', async (orig) => {
  const db = {
    select: () => ({ from: () => ({ where: async () => [
      { id: 1, url: 'https://hooks.example.com/x', secret: STORED, watchAddress: null, eventTypes: ['tx'] },
    ] }) }),
    execute: async () => [{ webhook_id: 1 }], // the delivery claim
    update: () => ({ set: () => ({ where: async () => [] }) }),
  }
  return { ...(await orig<typeof import('../../indexer/src/db')>()), getDb: () => db }
})
vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }))

const page = readFileSync(fileURLToPath(new URL('../app/developer/page.tsx', import.meta.url)), 'utf8')

/** The published verifyWebhook, compiled from the page's own source. */
function publishedVerifier(): (body: string, signature: string, secret: string) => boolean {
  const src = page.match(/function verifyWebhook[\s\S]*?\n}(?=`)/)?.[0]
  if (!src) throw new Error('verifyWebhook sample not found on the developer page')
  return new Function('crypto', 'Buffer', `${src}\nreturn verifyWebhook`)(crypto, Buffer)
}

/** The published payload sample, parsed. */
function publishedPayload(): Record<string, unknown> {
  const block = page.match(/label="Webhook Payload Format">\{`[^\n]*\n([\s\S]*?)\n\n\/\/ Headers/)?.[1]
  if (!block) throw new Error('payload sample not found on the developer page')
  return JSON.parse(block)
}

async function deliverOne(): Promise<{ body: string; signature: string }> {
  let sent: RequestInit | undefined
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent = init
    return new Response(null, { status: 200 })
  })
  const { notifyWebhooks } = await import('../../indexer/src/webhook-notifier')
  await notifyWebhooks(
    [{ hash: '0x01', fromAddress: '0x' + 'b'.repeat(40), toAddress: '0x' + 'c'.repeat(40), value: '1' }],
    42, new Date(0), '0x42',
  )
  if (!sent) throw new Error('no delivery was attempted')
  const headers = sent.headers as Record<string, string>
  return { body: sent.body as string, signature: headers['X-BNBScan-Signature'] }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('developer page webhook samples', () => {
  it('the verification sample accepts a real delivery, given the raw secret', async () => {
    const { body, signature } = await deliverOne()
    const verify = publishedVerifier()
    expect(verify(body, signature, RAW_SECRET)).toBe(true)
    expect(verify(body + ' ', signature, RAW_SECRET)).toBe(false)
    expect(verify(body, signature, 'b'.repeat(64))).toBe(false)
    // A short or malformed header is a rejection, not a timingSafeEqual throw.
    expect(verify(body, 'sha256=00', RAW_SECRET)).toBe(false)
  })

  it('the payload sample has the shape a real delivery has', async () => {
    const { body } = await deliverOne()
    const real = JSON.parse(body)
    const documented = publishedPayload()
    expect(Object.keys(documented).sort()).toEqual(Object.keys(real).sort())
    expect(Array.isArray(documented.data)).toBe(true)
    expect(Object.keys((documented.data as object[])[0]).sort()).toEqual(Object.keys(real.data[0]).sort())
  })
})
