/**
 * Chain-aware DB singleton for the indexer.
 * All indexer modules should import getDb from here, not from @altscan/db directly.
 */
import { getDb as _getDb, schema } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'

const chain = getChainConfig()

export function getDb() {
  return _getDb(chain.dbEnvVar)
}

export { schema }
