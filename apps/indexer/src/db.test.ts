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

  // Captured through postgres.js against localhost, which resolves to ::1 and
  // 127.0.0.1: Node tries every address of a multi-address host and, once all
  // are refused, fails with an AggregateError whose .message is empty. The
  // per-address "connect ECONNREFUSED ..." errors sit in .errors, so only the
  // .code Node copies from the first attempt says ECONNREFUSED.
  it('retries a refused connection to a host with several addresses', () => {
    const refused = Object.assign(
      new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      ]),
      { code: 'ECONNREFUSED' },
    )
    expect(isConnectionError(wrap(refused))).toBe(true)
  })

  it('does not retry a statement the database answered and refused', () => {
    const denied = Object.assign(new Error('permission denied for schema public'), { code: '42501' })
    expect(isConnectionError(wrap(denied))).toBe(false)
  })

  // Captured against a real postgres:16: a query cut off mid-flight (the backend
  // killed via pg_terminate_backend) surfaces from postgres.js as a plain Error,
  // never the Postgres 57P01 "terminating connection due to administrator command"
  // message — only .code identifies it, same as 53300 above.
  it('retries when postgres.js reports the connection closed mid-query', () => {
    const closed = Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:5432'), { code: 'CONNECTION_CLOSED' })
    expect(isConnectionError(wrap(closed))).toBe(true)
  })

  // postgres.js's connection.js builds CONNECTION_CLOSED, CONNECTION_ENDED,
  // CONNECTION_DESTROYED and CONNECT_TIMEOUT from the same Errors.connection()
  // factory (postgres@3.4.8 src/errors.js) — identical "write <CODE> host:port"
  // shape, only the code differs. CONNECTION_CLOSED is covered above; these are
  // its siblings, confirmed against that source rather than re-triggered live.
  it('retries the other postgres.js socket-teardown codes', () => {
    const ended = Object.assign(new Error('write CONNECTION_ENDED 127.0.0.1:5432'), { code: 'CONNECTION_ENDED' })
    const destroyed = Object.assign(new Error('write CONNECTION_DESTROYED 127.0.0.1:5432'), { code: 'CONNECTION_DESTROYED' })
    const timeout = Object.assign(new Error('write CONNECT_TIMEOUT 127.0.0.1:5432'), { code: 'CONNECT_TIMEOUT' })
    expect(isConnectionError(wrap(ended))).toBe(true)
    expect(isConnectionError(wrap(destroyed))).toBe(true)
    expect(isConnectionError(wrap(timeout))).toBe(true)
  })

  // Captured against a real postgres:16: cannot_connect_now (57P03) covers "the
  // database system is starting up", "...is shutting down" and "...is in recovery
  // mode" — a genuine PostgresError this time (the server answered), but the
  // message text is not "connection" or "ECONNREFUSED" so only .code catches it.
  it('retries cannot_connect_now while the database is starting up', () => {
    const startingUp = Object.assign(new Error('the database system is starting up'), { code: '57P03' })
    expect(isConnectionError(wrap(startingUp))).toBe(true)
  })

  it('retries cannot_connect_now while the database is shutting down', () => {
    const shuttingDown = Object.assign(new Error('the database system is shutting down'), { code: '57P03' })
    expect(isConnectionError(wrap(shuttingDown))).toBe(true)
  })

  // Captured against a real postgres:16: a forced TCP RST mid-query surfaces from
  // Node as a plain Error with code ECONNRESET and message "read ECONNRESET" — no
  // "connection" substring, so the existing message check misses it too.
  it('retries a connection reset mid-query', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(isConnectionError(wrap(reset))).toBe(true)
  })

  // Deliberately NOT a connection error: a bad hostname or password is a
  // misconfiguration, not a database that will become reachable if we wait. The
  // retry loop is bounded at 20 attempts (apps/indexer/src/index.ts) — treating
  // this as retryable would mean minutes of silent backoff before the boot fails
  // instead of exiting 1 immediately and surfacing the real problem.
  it('does not retry a DNS/auth misconfiguration', () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND bad.invalid'), { code: 'ENOTFOUND' })
    expect(isConnectionError(wrap(notFound))).toBe(false)
  })
})
