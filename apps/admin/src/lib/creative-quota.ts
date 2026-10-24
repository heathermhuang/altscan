import { MAX_CREATIVE_OBJECTS_PER_EXPLORER } from './creative-upload'

/** The part of a D1 binding this module uses. */
export type D1Like = {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown> }
  }
}

/**
 * Reserve one of an explorer's creative slots: write the upload's audit row, but only
 * while the explorer holds fewer than MAX_CREATIVE_OBJECTS_PER_EXPLORER distinct keys.
 *
 * The bucket listing alone was a check-then-act: concurrent uploads all listed the same
 * count before any of them stored an object, so the quota could be overshot by however
 * many were in flight. The audit table already carries one creative.upload row per
 * stored key, and D1 runs each statement atomically, so a conditional INSERT is the
 * reservation. A retry of the same key is not counted against itself.
 *
 * Returns the audit row's id, or null when the quota is full. Run it only for a key not
 * yet in the bucket; re-uploading stored bytes is free.
 */
export async function reserveCreativeSlot(db: D1Like, r: {
  actorEmail: string; tenantId: string; explorerId: string; key: string; payload: string; at: number
}): Promise<number | null> {
  const row = await db.prepare(`
    INSERT INTO audit (actor_email, tenant_id, explorer_id, action, payload, at)
    SELECT ?1, ?2, ?3, 'creative.upload', ?4, ?5
    WHERE (
      SELECT count(DISTINCT json_extract(payload, '$.key')) FROM audit
       WHERE tenant_id = ?2 AND explorer_id = ?3 AND action = 'creative.upload'
         AND json_extract(payload, '$.key') <> ?6
    ) < ?7
    RETURNING id
  `).bind(r.actorEmail, r.tenantId, r.explorerId, r.payload, r.at, r.key, MAX_CREATIVE_OBJECTS_PER_EXPLORER)
    .first<{ id: number }>()
  return row?.id ?? null
}

/** Undo a reservation whose object never got stored. */
export async function releaseCreativeSlot(db: D1Like, auditId: number): Promise<void> {
  await db.prepare(`DELETE FROM audit WHERE id = ?1 AND action = 'creative.upload'`).bind(auditId).run()
}
