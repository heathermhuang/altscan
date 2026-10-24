/**
 * The creative quota's reservation, run against real SQLite (D1's engine) with the schema
 * from the admin's own migration. node:sqlite ships with Node 22.13+; the suite skips
 * where it is missing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_CREATIVE_OBJECTS_PER_EXPLORER } from './creative-upload'
import { releaseCreativeSlot, reserveCreativeSlot, type D1Like } from './creative-quota'

type Sqlite = { exec(sql: string): void; prepare(sql: string): { get(...v: unknown[]): unknown; run(...v: unknown[]): unknown } }
// Through a variable: the admin's Node typings predate node:sqlite, and the type is declared above.
const SQLITE = 'node:sqlite'
const sqlite = await import(/* @vite-ignore */ SQLITE).catch(() => null) as { DatabaseSync: new (path: string) => Sqlite } | null
const MIGRATION = fileURLToPath(new URL('../../migrations/0001_init.sql', import.meta.url))

/** node:sqlite behind the D1 surface reserveCreativeSlot uses. */
function d1(db: Sqlite): D1Like {
  return {
    prepare: (q) => ({
      bind: (...v) => ({
        first: async <T,>() => (db.prepare(q).get(...v) ?? null) as T | null,
        run: async () => db.prepare(q).run(...v),
      }),
    }),
  }
}

describe.skipIf(!sqlite)('reserveCreativeSlot', () => {
  let raw: Sqlite
  let db: D1Like
  const reserve = (key: string, explorerId = 'x1') =>
    reserveCreativeSlot(db, { actorEmail: 'a@example.com', tenantId: 't1', explorerId, key, payload: JSON.stringify({ key }), at: 1 })
  const fill = async (n: number) => { for (let i = 0; i < n; i++) expect(await reserve(`t1/x1/${i}.png`)).not.toBeNull() }

  beforeEach(() => {
    raw = new sqlite!.DatabaseSync(':memory:')
    raw.exec(readFileSync(MIGRATION, 'utf8'))
    db = d1(raw)
  })

  it('reserves up to the quota, then refuses', async () => {
    await fill(MAX_CREATIVE_OBJECTS_PER_EXPLORER)
    expect(await reserve('t1/x1/one-too-many.png')).toBeNull()
    const { n } = raw.prepare("SELECT count(*) AS n FROM audit WHERE action = 'creative.upload'").get() as { n: number }
    expect(n).toBe(MAX_CREATIVE_OBJECTS_PER_EXPLORER)
  })

  it('does not count a retried key against itself at the cap', async () => {
    await fill(MAX_CREATIVE_OBJECTS_PER_EXPLORER - 1)
    expect(await reserve('t1/x1/retry.png')).not.toBeNull()  // the last slot
    expect(await reserve('t1/x1/retry.png')).not.toBeNull()  // the same key again: still 200 distinct
    expect(await reserve('t1/x1/new.png')).toBeNull()
  })

  it('counts per explorer', async () => {
    await fill(MAX_CREATIVE_OBJECTS_PER_EXPLORER)
    expect(await reserve('t1/x2/a.png', 'x2')).not.toBeNull()
  })

  it('a released reservation frees its slot', async () => {
    await fill(MAX_CREATIVE_OBJECTS_PER_EXPLORER - 1)
    const id = await reserve('t1/x1/failed-put.png')
    expect(id).not.toBeNull()
    expect(await reserve('t1/x1/next.png')).toBeNull()
    await releaseCreativeSlot(db, id!)
    expect(await reserve('t1/x1/next.png')).not.toBeNull()
  })
})
