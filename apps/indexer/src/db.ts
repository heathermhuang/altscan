/**
 * Chain-aware DB singleton for the indexer.
 * All indexer modules should import getDb from here, not from @altscan/db directly.
 */
import { getDb as _getDb, getMaintenanceDb as _getMaintenanceDb, getWriterDb as _getWriterDb, schema, dbErrorMessage, unwrapDbError } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'

const chain = getChainConfig()

export function getDb() {
  return _getDb(chain.dbEnvVar)
}

// Dedicated, isolated pool for background maintenance (retention deletes,
// holder-count recompute) so those jobs never occupy the ingestion pool's slots.
/**
 * Pool for the async transfer writer. Returns the SHARED ingestion pool unless
 * TT_WRITER_DEDICATED_POOL=1, so this is a no-op until the A/B is run.
 */
export function getWriterDb() {
  return _getWriterDb(chain.dbEnvVar)
}

export function getMaintenanceDb() {
  return _getMaintenanceDb(chain.dbEnvVar)
}

export { schema, dbErrorMessage, unwrapDbError }

// postgres.js's own synthetic errors for a socket that closed, ended, was
// destroyed, or timed out connecting mid-flight (postgres@3.4.8 src/errors.js,
// Errors.connection()) — plain Errors whose message is "write <CODE> host:port",
// never a Postgres protocol message, so only .code identifies them.
const POSTGRES_JS_SOCKET_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
])

/**
 * The database cannot take a connection right now, so the boot retries instead
 * of exiting. Postgres never puts the SQLSTATE in the message: once every slot is
 * taken, too_many_connections says only "sorry, too many clients already", so it
 * is recognised by its code. Same for cannot_connect_now (57P03 — starting up,
 * shutting down, or in recovery) and for the driver/transport-level codes below:
 * none of their messages contain "connection" or "ECONNREFUSED".
 */
export function isConnectionError(err: unknown): boolean {
  const code = (unwrapDbError(err) as { code?: string })?.code
  if (code === '53300' || code === '57P03') return true
  if (code === 'ECONNRESET') return true
  if (code !== undefined && POSTGRES_JS_SOCKET_CODES.has(code)) return true
  const msg = dbErrorMessage(err)
  return msg.includes('connection') || msg.includes('ECONNREFUSED')
}
