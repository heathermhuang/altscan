import { and, asc, eq, sql } from 'drizzle-orm'
import { schema, type Db } from '@altscan/db'
import { isHexAddress } from './hex'

/** Watched addresses per owner. Sized for individuals and small bots, not deposit-monitor services. */
export const WATCH_MAX_ADDRESSES = (() => {
  const n = Number(process.env.WATCH_MAX_ADDRESSES)
  return Number.isInteger(n) && n > 0 ? n : 50
})()

export type Normalized = { ok: true; addresses: string[] } | { ok: false; invalid: string[] }

/** Lowercased, deduped addresses, or every entry that is not one. An empty or non-array input is invalid. */
export function normalizeAddresses(input: unknown): Normalized {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, invalid: [] }
  const invalid = input.filter((a) => typeof a !== 'string' || !isHexAddress(a)).map((a) => String(a))
  if (invalid.length > 0) return { ok: false, invalid }
  return { ok: true, addresses: [...new Set((input as string[]).map((a) => a.toLowerCase()))] }
}

export type AddResult = { ok: true; added: number; total: number } | { ok: false; status: 400; error: string }

/**
 * Add addresses to an owner's watchlist: the cap check and the insert run in one transaction holding a
 * per-owner advisory lock (the mintApiKey pattern), so parallel requests cannot read the same pre-insert
 * count and overrun the cap. Addresses already watched are no-ops; over the cap, nothing is added.
 */
export async function addWatchAddresses(db: Db, owner: string, addresses: string[], label: string | null): Promise<AddResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`watch_addresses:${owner}`}))`)
    const existing = new Set((await tx.select({ address: schema.watchAddresses.address })
      .from(schema.watchAddresses)
      .where(eq(schema.watchAddresses.ownerAddress, owner))).map((r) => r.address))
    const fresh = addresses.filter((a) => !existing.has(a))
    if (existing.size + fresh.length > WATCH_MAX_ADDRESSES) {
      return { ok: false as const, status: 400 as const,
        error: `Maximum ${WATCH_MAX_ADDRESSES} watched addresses per owner (${existing.size} already watched)` }
    }
    if (fresh.length > 0) {
      await tx.insert(schema.watchAddresses)
        .values(fresh.map((address) => ({ ownerAddress: owner, address, label })))
        .onConflictDoNothing()
    }
    return { ok: true as const, added: fresh.length, total: existing.size + fresh.length }
  })
}

export async function listWatchAddresses(db: Db, owner: string) {
  return db.select({
    address: schema.watchAddresses.address,
    label: schema.watchAddresses.label,
    createdAt: schema.watchAddresses.createdAt,
  }).from(schema.watchAddresses)
    .where(eq(schema.watchAddresses.ownerAddress, owner))
    .orderBy(asc(schema.watchAddresses.createdAt), asc(schema.watchAddresses.address))
}

/** true when the address was watched and is now removed. */
export async function removeWatchAddress(db: Db, owner: string, address: string): Promise<boolean> {
  const removed = await db.delete(schema.watchAddresses)
    .where(and(eq(schema.watchAddresses.ownerAddress, owner), eq(schema.watchAddresses.address, address)))
    .returning({ address: schema.watchAddresses.address })
  return removed.length > 0
}

/**
 * The table does not exist yet: the web service deployed before the indexer's ensure-schema created it.
 * drizzle ≥0.44 wraps driver errors, so SQLSTATE sits on `.code` of the error or of a `.cause`.
 */
export function isUndefinedTable(e: unknown): boolean {
  return hasSqlState(e, '42P01')
}

/** Whether the error, or a `.cause` within five levels, carries this SQLSTATE. */
export function hasSqlState(e: unknown, code: string): boolean {
  let c = e as { code?: unknown; cause?: unknown } | null | undefined
  for (let depth = 0; c && depth < 5; depth++) {
    if (c.code === code) return true
    c = c.cause as typeof c
  }
  return false
}
