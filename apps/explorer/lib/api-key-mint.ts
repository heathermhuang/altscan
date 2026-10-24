import { eq, sql } from 'drizzle-orm'
import { schema, type Db } from '@altscan/db'

export const MAX_KEYS_PER_ADDRESS = 10

type Refusal = { ok: false; status: number; error: string }
export type MintResult = { ok: true; id: number } | Refusal

/**
 * Mint an API key row: the existing-key check, the per-address cap and the insert, in
 * one transaction holding a per-owner advisory lock.
 *
 * Without the lock, parallel requests all read the same pre-insert state. An address
 * with no keys could then be given several on the wallet signature alone (once it has
 * one, every further key needs one of its keys), and the cap could be overrun, each
 * extra key bringing its own rate-limit budget. Webhook registration uses the same
 * pattern. The lock releases on commit or rollback.
 *
 * `authorizeExisting` runs only when the owner already holds a key: it is the
 * X-API-Key ownership check.
 */
export async function mintApiKey(
  db: Db,
  owner: string,
  key: { keyHash: string; keyPrefix: string; label: string | null },
  authorizeExisting: () => Promise<{ ok: true } | Refusal>,
): Promise<MintResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`api_keys:${owner}`}))`)
    const existing = await tx.select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.ownerAddress, owner))
    if (existing.length > 0) {
      const auth = await authorizeExisting()
      if (!auth.ok) return auth
    }
    if (existing.length >= MAX_KEYS_PER_ADDRESS) {
      return { ok: false, status: 400, error: `Maximum ${MAX_KEYS_PER_ADDRESS} API keys per address` }
    }
    const [created] = await tx.insert(schema.apiKeys).values({
      ...key,
      ownerAddress: owner,
      requestsPerMinute: 100,
      totalRequests: 0,
      active: true,
    }).returning({ id: schema.apiKeys.id })
    return { ok: true, id: created.id }
  })
}
