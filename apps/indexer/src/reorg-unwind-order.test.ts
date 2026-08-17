import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
// Static import: vi.mock is hoisted above it. A top-level `await import()` would
// break the indexer's tsc --noEmit (its module target forbids top-level await), which
// vitest and CI both pass but the indexer DEPLOY does not.
import { unwindFrom, UNWIND_ORDER } from './reorg-handler'

/**
 * unwindFrom must delete poison_blocks BEFORE anything else.
 *
 * Ordering is the whole correctness argument, and getting it wrong is silent. With
 * the poison delete LAST, a failure there leaves the ordinary deletes committed — so
 * the stored tip row is already gone, detectReorg reads a missing stored hash as
 * "nothing to validate", reports no reorg, and the deleted canonical tail is never
 * reprocessed until a restart. Running it FIRST means a failure leaves the index
 * untouched and the next check still sees the mismatch.
 *
 * The db module is mocked, so this asserts pure call ORDER and touches no database.
 */
const calls: string[] = []

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('@altscan/db')>('@altscan/db')
  const chain = { where: () => Promise.resolve(undefined) }
  return {
    schema: actual.schema,
    getDb: () => ({
      execute: (q: unknown) => {
        // The drizzle sql`` tag exposes its literal chunks; find the table name.
        const text = JSON.stringify(q)
        calls.push(
          text.includes('poison_blocks') ? 'poison_blocks'
          : text.includes('heal_cursor') ? 'index_gaps:heal_cursor'
          : 'execute:other')
        return Promise.resolve([])
      },
      delete: (table: unknown) => {
        // drizzle keeps the table name behind a symbol; getTableName is the API.
        calls.push(getTableName(table as never))
        return chain
      },
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    }),
  }
})


describe('unwindFrom ordering', () => {
  beforeEach(() => { calls.length = 0 })

  it('deletes poison_blocks FIRST, before any block-scoped table', async () => {
    await unwindFrom(500)
    expect(calls[0]).toBe('poison_blocks')
  })

  it('rewinds a heal_cursor above the fork, also before the unwind', async () => {
    // Height-keyed state again: heal_cursor claims "everything up to here was
    // re-indexed, drained and verified" about blocks this unwind is deleting. Left
    // alone, the healer's work window starts past the damage it can never reach.
    await unwindFrom(500)
    expect(calls.slice(0, 2)).toContain('index_gaps:heal_cursor')
  })

  it('still unwinds every table in UNWIND_ORDER after the pre-deletes', async () => {
    await unwindFrom(500)
    // Two pre-deletes (poison_blocks, heal_cursor rewind) then one per manifest entry.
    expect(calls.length).toBe(UNWIND_ORDER.length + 2)
    expect(calls.slice(2).every(c => c !== 'poison_blocks')).toBe(true)
  })

  it('blocks is unwound LAST, so the FK from transactions still holds', async () => {
    await unwindFrom(500)
    expect(calls[calls.length - 1]).toBe('blocks')
  })
})
