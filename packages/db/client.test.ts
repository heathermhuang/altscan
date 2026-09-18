import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { dbErrorMessage, unwrapDbError } from './client'

// What postgres.js rejects with when the server reports a deadlock. The runtime
// constructor takes the parsed ErrorResponse fields, not a message string.
const deadlock = new postgres.PostgresError({ message: 'deadlock detected', code: '40P01' } as never)

// A real drizzle instance over a client whose every query fails with `err`, so
// the wrapper under test is the one drizzle itself throws.
async function failedQuery(err: unknown): Promise<unknown> {
  const client = { options: { parsers: {}, serializers: {} }, unsafe: () => Promise.reject(err) }
  const db = drizzle(client as never)
  return db.execute(sql`INSERT INTO addresses (address) VALUES (${'0xabc'})`).then(
    () => { throw new Error('the query was supposed to fail') },
    (e: unknown) => e,
  )
}

describe('unwrapDbError', () => {
  it('returns the postgres error a failed query was wrapped around', async () => {
    const thrown = await failedQuery(deadlock)
    expect(thrown).not.toBe(deadlock)
    expect(unwrapDbError(thrown)).toBe(deadlock)
  })

  it('returns anything that is not a wrapped query error unchanged', () => {
    const plain = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    expect(unwrapDbError(plain)).toBe(plain)
    expect(unwrapDbError(deadlock)).toBe(deadlock)
    expect(unwrapDbError('boom')).toBe('boom')
    expect(unwrapDbError(undefined)).toBe(undefined)
  })
})

describe('dbErrorMessage', () => {
  it('is what Postgres said, not the SQL and params of the failed query', async () => {
    const message = dbErrorMessage(await failedQuery(deadlock))
    expect(message).toBe('deadlock detected')
  })

  it('is the message of a connection error the driver threw', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
    expect(dbErrorMessage(await failedQuery(refused))).toBe('connect ECONNREFUSED 127.0.0.1:5432')
  })

  it('falls back to the message, or the string form, of anything else', () => {
    expect(dbErrorMessage(new Error('plain'))).toBe('plain')
    expect(dbErrorMessage('boom')).toBe('boom')
  })
})
