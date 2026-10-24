/**
 * Delivery from a sealed signing key (webhook-secret.ts), through the real
 * notifyWebhooks with its database and network faked.
 *
 * Sealing must be invisible to consumers: the same signing key, so byte-identical
 * signatures. And a key the indexer cannot open must cost nothing but that
 * delivery: no claim, no failure counted toward deactivation.
 */
import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sealSigningKey } from './webhook-secret'

const KEY_HEX = 'cd'.repeat(32)
const KEY = Buffer.from(KEY_HEX, 'hex')
const STORED = crypto.createHash('sha256').update('raw secret').digest('hex')

type Row = { id: number; url: string; secret: string | null; secretEnc: string | null; watchAddress: null; eventTypes: string[] }
const h = vi.hoisted(() => ({ row: null as unknown as Row, executes: 0, updates: 0 }))

vi.mock('./db', async (orig) => {
  const db = {
    select: () => ({ from: () => ({ where: async () => [h.row] }) }),
    execute: async () => { h.executes++; return [{ webhook_id: h.row.id }] }, // the delivery claim
    update: () => ({ set: () => ({ where: async () => { h.updates++; return [] } }) }),
  }
  return { ...(await orig<typeof import('./db')>()), getDb: () => db }
})
vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }))

const row = (over: Partial<Row>): Row =>
  ({ id: 1, url: 'https://hooks.example.com/x', secret: null, secretEnc: null, watchAddress: null, eventTypes: ['tx'], ...over })

/** One block through a freshly imported notifier (config is read at import). */
async function deliver(): Promise<{ body: string; signature: string } | null> {
  let sent: RequestInit | undefined
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = init; return new Response(null, { status: 200 }) })
  vi.resetModules()
  const { notifyWebhooks } = await import('./webhook-notifier')
  await notifyWebhooks([{ hash: '0x01', fromAddress: '0x' + 'a'.repeat(40), toAddress: null, value: '1' }], 7, new Date(0), '0x07')
  if (!sent) return null
  return { body: sent.body as string, signature: (sent.headers as Record<string, string>)['X-BNBScan-Signature'] }
}

const hmac = (key: string, body: string) => 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex')

beforeEach(() => { h.executes = 0; h.updates = 0 })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('delivery from a sealed signing key', () => {
  it('signs byte-identically to the plaintext key it replaced', async () => {
    vi.stubEnv('WEBHOOK_SECRET_KEY', KEY_HEX)
    h.row = row({ secret: STORED })
    const plain = await deliver()
    h.row = row({ secretEnc: sealSigningKey(STORED, KEY, 1) })
    const sealed = await deliver()
    expect(sealed).not.toBeNull()
    expect(sealed!.body).toBe(plain!.body)
    expect(sealed!.signature).toBe(plain!.signature)
    expect(sealed!.signature).toBe(hmac(STORED, sealed!.body))
  })

  it.each([
    ['WEBHOOK_SECRET_KEY is unset', '', 1],
    ['WEBHOOK_SECRET_KEY is malformed (fails closed)', 'not-a-key', 1],
    ['the key was sealed for another webhook', KEY_HEX, 2],
  ])('is skipped, unclaimed and not counted as a failure when %s', async (_label, env, sealedFor) => {
    vi.stubEnv('WEBHOOK_SECRET_KEY', env)
    h.row = row({ secretEnc: sealSigningKey(STORED, KEY, sealedFor) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await deliver()).toBeNull()
    expect(h.executes).toBe(0) // no delivery claim
    expect(h.updates).toBe(0)  // no fail_count write
  })
})
