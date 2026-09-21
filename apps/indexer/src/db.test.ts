import { describe, it, expect } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { isConnectionError } from './db'

// The boot retries ensureSchema() while this says the database cannot take a
// connection yet; anything else exits 1. drizzle rethrows every driver error as
// a DrizzleQueryError, so each case arrives wrapped, as it did against a
// postgres:16 with max_connections exhausted.
describe('isConnectionError (boot-time ensureSchema retry)', () => {
  const wrap = (cause: Error) => new DrizzleQueryError(
    `DO $$ BEGIN CREATE TYPE token_type AS ENUM ('BEP20','BEP721','BEP1155'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    [],
    cause,
  )

  it('retries too_many_connections once every slot is taken', () => {
    // A Postgres message never contains its SQLSTATE, and this one does not say
    // "connection" either: only the code identifies it.
    const full = Object.assign(new Error('sorry, too many clients already'), { code: '53300' })
    expect(isConnectionError(wrap(full))).toBe(true)
  })

  it('retries too_many_connections while only reserved slots remain', () => {
    const reserved = Object.assign(
      new Error('remaining connection slots are reserved for roles with the SUPERUSER attribute'),
      { code: '53300' },
    )
    expect(isConnectionError(wrap(reserved))).toBe(true)
  })

  it('retries a refused TCP connection', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
    expect(isConnectionError(wrap(refused))).toBe(true)
  })

  it('does not retry a statement the database answered and refused', () => {
    const denied = Object.assign(new Error('permission denied for schema public'), { code: '42501' })
    expect(isConnectionError(wrap(denied))).toBe(false)
  })
})
