import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createMaintenanceConnection, schema } from '@altscan/db'
import crypto from 'crypto'
import { openSigningKey } from './webhook-secret'

/**
 * Webhook failure accounting against a REAL Postgres, through the shipped notifyWebhooks.
 *
 * The select that feeds a run never loaded fail_count, so every failure wrote 1 and the
 * five-failure deactivation could not fire. The count is now incremented in SQL; this
 * pins that five consecutive failures deactivate, that a success resets the count, and
 * that a failure landing after a concurrent run deactivated the row does not revive it
 * (runs overlap: notifyWebhooks is fired per block without being awaited). It also pins
 * that sealing a signing key at rest clears the plaintext without changing a signature.
 *
 * Gated on WEBHOOK_TEST_PG_URL. Everything lives in its own schema on ONE connection.
 * Run locally with:
 *
 *   docker run -d --rm --name pg-webhook -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=webhook_test -p 127.0.0.1:5466:5432 postgres:16
 *   WEBHOOK_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5466/webhook_test \
 *     npx vitest run apps/indexer/src/webhook-notifier.pg.test.ts
 */
const ENV = 'WEBHOOK_TEST_PG_URL'
const PG_URL = process.env[ENV]
const SCHEMA = 'webhook_notify_test'
const ADDR = '0x' + 'a'.repeat(40)

const KEY_HEX = 'ef'.repeat(32)
const KEY = Buffer.from(KEY_HEX, 'hex')

const h = vi.hoisted(() => ({
  db: null as unknown,
  onFetch: async (_url?: string, _init?: RequestInit): Promise<Response> => new Response(null, { status: 500 }),
}))
vi.mock('./db', async (orig) => ({ ...(await orig<typeof import('./db')>()), getDb: () => h.db }))
vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }))

describe.skipIf(!PG_URL)('webhook failure accounting — against a real Postgres', () => {
  let conn: ReturnType<typeof createMaintenanceConnection>
  let notifyWebhooks: typeof import('./webhook-notifier').notifyWebhooks
  let sealPlaintextWebhookSecrets: typeof import('./webhook-notifier').sealPlaintextWebhookSecrets
  let block = 0

  const notify = () => {
    block++
    return notifyWebhooks(
      [{ hash: '0x' + block.toString(16).padStart(64, '0'), fromAddress: ADDR, toAddress: null, value: '1' }],
      block, new Date(), '0x' + block.toString(16).padStart(64, 'f'),
    )
  }
  const row = async () => {
    const [r] = await conn.unsafe('SELECT fail_count, active FROM webhooks WHERE id = 1')
    return { fail_count: r.fail_count as number, active: r.active as boolean }
  }

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    conn = createMaintenanceConnection(PG_URL as string)
    const [{ db: name }] = await conn.unsafe('SELECT current_database() AS db')
    if (!/test/i.test(String(name))) throw new Error(`${ENV} connected to "${name}", which is not a disposable database`)
    await conn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await conn.unsafe(`CREATE SCHEMA ${SCHEMA}`)
    await conn.unsafe(`SET search_path TO ${SCHEMA}`)
    // Columns as packages/db/schema.ts and the ledger as ensure-schema.ts create them.
    await conn.unsafe(`
      CREATE TABLE webhooks (
        id serial PRIMARY KEY,
        owner_address varchar(42) NOT NULL,
        url text NOT NULL,
        watch_address varchar(42),
        event_types text[] NOT NULL DEFAULT '{tx}',
        secret varchar(64),
        secret_enc text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_triggered_at timestamptz,
        fail_count integer NOT NULL DEFAULT 0
      );
      CREATE TABLE webhook_deliveries (
        webhook_id integer NOT NULL,
        block_hash varchar(66) NOT NULL,
        block_number bigint NOT NULL,
        delivered_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (webhook_id, block_hash)
      );
      CREATE UNIQUE INDEX webhook_deliveries_hash_key
        ON webhook_deliveries (webhook_id, block_hash) WHERE block_hash IS NOT NULL;
    `)
    h.db = drizzle(conn, { schema })
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => h.onFetch(url, init))
    vi.stubEnv('WEBHOOK_SECRET_KEY', KEY_HEX) // read when the notifier's config loads, just below
    ;({ notifyWebhooks, sealPlaintextWebhookSecrets } = await import('./webhook-notifier'))
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (!conn) return
    await conn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await conn.end()
  })

  beforeEach(async () => {
    h.onFetch = async () => new Response(null, { status: 500 })
    await conn.unsafe('TRUNCATE webhooks, webhook_deliveries RESTART IDENTITY')
    await conn.unsafe(`INSERT INTO webhooks (owner_address, url, secret) VALUES ('${ADDR}', 'https://hooks.example.com/x', 'k')`)
  })

  it('deactivates on the fifth consecutive failure', async () => {
    for (let i = 0; i < 4; i++) await notify()
    expect(await row()).toEqual({ fail_count: 4, active: true })
    await notify()
    expect(await row()).toEqual({ fail_count: 5, active: false })
  })

  it('resets the count on a success', async () => {
    for (let i = 0; i < 3; i++) await notify()
    h.onFetch = async () => new Response(null, { status: 200 })
    await notify()
    expect(await row()).toEqual({ fail_count: 0, active: true })
    h.onFetch = async () => new Response(null, { status: 500 })
    await notify()
    expect(await row()).toEqual({ fail_count: 1, active: true })
  })

  it('does not revive a row another run deactivated mid-delivery', async () => {
    h.onFetch = async () => {
      await conn.unsafe('UPDATE webhooks SET active = false, fail_count = 0 WHERE id = 1')
      return new Response(null, { status: 500 })
    }
    await notify()
    expect(await row()).toEqual({ fail_count: 1, active: false })
  })

  it('seals the plaintext signing key, clears it, and keeps every signature identical', async () => {
    const sent: Array<{ body: string; signature: string }> = []
    h.onFetch = async (_url, init) => {
      sent.push({ body: init!.body as string, signature: (init!.headers as Record<string, string>)['X-BNBScan-Signature'] })
      return new Response(null, { status: 200 })
    }
    await notify() // from the plaintext key

    expect(await sealPlaintextWebhookSecrets(KEY)).toBe(1)
    expect(await sealPlaintextWebhookSecrets(KEY)).toBe(0) // idempotent
    const [stored] = await conn.unsafe('SELECT secret, secret_enc FROM webhooks WHERE id = 1')
    expect(stored.secret).toBeNull()
    expect(openSigningKey(stored.secret_enc as string, KEY, 1)).toBe('k')

    await notify() // from the sealed key
    expect(sent).toHaveLength(2)
    for (const { body, signature } of sent) {
      expect(signature).toBe('sha256=' + crypto.createHmac('sha256', 'k').update(body).digest('hex'))
    }
    expect(await row()).toEqual({ fail_count: 0, active: true })
  })
})
