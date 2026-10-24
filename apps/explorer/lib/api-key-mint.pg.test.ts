/**
 * API key minting under concurrency, against a REAL Postgres with a real connection pool.
 *
 * The existence check, the 10-key cap and the insert used to be three separate
 * statements, so parallel requests all read the same pre-insert state: an address with
 * no keys got several on the wallet signature alone, and the cap could be overrun.
 * mintApiKey serializes them per owner with an advisory lock.
 *
 * Gated on API_KEY_MINT_TEST_PG_URL, which must name a disposable database (its name must
 * contain "test"); the suite creates and drops `api_keys` there. Run locally with:
 *
 *   docker run -d --rm --name pg-keys -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=key_mint_test -p 127.0.0.1:5467:5432 postgres:16
 *   API_KEY_MINT_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5467/key_mint_test \
 *     npx vitest run apps/explorer/lib/api-key-mint.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, type Db } from '@altscan/db'
import { MAX_KEYS_PER_ADDRESS, mintApiKey } from './api-key-mint'

const ENV = 'API_KEY_MINT_TEST_PG_URL'
const PG_URL = process.env[ENV]
const OWNER = '0x' + 'a'.repeat(40)
const PARALLEL = 15

describe.skipIf(!PG_URL)('mintApiKey under concurrency — against a real Postgres', () => {
  let db: Db
  let n = 0
  const key = () => ({ keyHash: `h${++n}`.padEnd(64, '0'), keyPrefix: `bnbs_${n}`.slice(0, 12), label: null })
  const count = async () => Number((Array.from(await db.execute(sql.raw('SELECT count(*) AS c FROM api_keys')))[0] as { c: string }).c)

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    process.env.DB_POOL_SIZE = String(PARALLEL) // enough connections for the requests to truly overlap
    db = getDb(ENV)
    // As apps/indexer/src/ensure-schema.ts creates it.
    await db.execute(sql.raw('DROP TABLE IF EXISTS api_keys'))
    await db.execute(sql.raw(`
      CREATE TABLE api_keys (
        id                  SERIAL PRIMARY KEY,
        key_hash            VARCHAR(64) UNIQUE NOT NULL,
        key_prefix          VARCHAR(12) NOT NULL,
        label               VARCHAR(255),
        owner_address       VARCHAR(42),
        requests_per_minute INTEGER NOT NULL DEFAULT 100,
        total_requests      BIGINT NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at        TIMESTAMPTZ,
        active              BOOLEAN NOT NULL DEFAULT true
      )`))
    // Open every pool connection now. The pool connects lazily, and connection setup
    // would otherwise space the first test's transactions out until they no longer overlap.
    await Promise.all(Array.from({ length: PARALLEL }, () => db.execute(sql.raw('SELECT pg_sleep(0.2)'))))
  })

  afterAll(async () => {
    if (db) await db.execute(sql.raw('DROP TABLE IF EXISTS api_keys'))
  })

  beforeEach(async () => { await db.execute(sql.raw('TRUNCATE api_keys RESTART IDENTITY')) })

  it('parallel signature-only requests for a new address mint exactly one key', async () => {
    // No X-API-Key: allowed only while the address holds no key.
    const refuseWithoutKey = { ok: false as const, status: 403, error: 'needs one of its keys' }
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => mintApiKey(db, OWNER, key(), refuseWithoutKey)))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.status === 403)).toHaveLength(PARALLEL - 1)
    expect(await count()).toBe(1)
  })

  it('parallel authorized requests never take an address past the cap', async () => {
    const authorized = { ok: true as const }
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => mintApiKey(db, OWNER, key(), authorized)))
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_KEYS_PER_ADDRESS)
    expect(results.filter((r) => !r.ok && r.status === 400)).toHaveLength(PARALLEL - MAX_KEYS_PER_ADDRESS)
    expect(await count()).toBe(MAX_KEYS_PER_ADDRESS)
  })

  it('revoked keys count toward neither the cap nor the has-a-key rule', async () => {
    const refuseWithoutKey = { ok: false as const, status: 403, error: 'needs one of its keys' }
    for (let i = 0; i < MAX_KEYS_PER_ADDRESS; i++) await mintApiKey(db, OWNER, key(), { ok: true })
    // At the cap, and holding keys: refused either way.
    expect((await mintApiKey(db, OWNER, key(), { ok: true })).ok).toBe(false)
    expect((await mintApiKey(db, OWNER, key(), refuseWithoutKey)).ok).toBe(false)

    // Revoke one: its slot is free again.
    await db.execute(sql.raw(`UPDATE api_keys SET active = false WHERE id = (SELECT min(id) FROM api_keys)`))
    expect((await mintApiKey(db, OWNER, key(), { ok: true })).ok).toBe(true)

    // Revoke every key: the owner holds none, so a signature alone mints one again (no requesting
    // key could pass the ownership check), and then the has-a-key rule applies as usual.
    await db.execute(sql.raw(`UPDATE api_keys SET active = false`))
    expect((await mintApiKey(db, OWNER, key(), refuseWithoutKey)).ok).toBe(true)
    expect((await mintApiKey(db, OWNER, key(), refuseWithoutKey)).ok).toBe(false)
    expect(await count()).toBe(MAX_KEYS_PER_ADDRESS + 2)
  })

  it('a burst of mints on a small pool cannot deadlock it', { timeout: 15_000 }, async () => {
    // Each request authorizes through the pool, as requireApiKeyOwner does, then mints. Run
    // inside the transaction, that lookup would hold one connection waiting for a second, and
    // six of them would take a two-connection pool and never finish.
    process.env.API_KEY_MINT_SMALL_POOL = PG_URL
    process.env.DB_POOL_SIZE = '2'
    const small = getDb('API_KEY_MINT_SMALL_POOL')
    const owners = Array.from({ length: 6 }, (_, i) => '0x' + String(i).repeat(40).slice(0, 40))
    for (const o of owners) await mintApiKey(small, o, key(), { ok: true })  // each already holds a key
    const results = await Promise.all(owners.map(async (o) => {
      await small.execute(sql`SELECT 1 FROM api_keys WHERE owner_address = ${o}`)  // the ownership lookup
      return mintApiKey(small, o, key(), { ok: true })
    }))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await count()).toBe(12)
  })
})
