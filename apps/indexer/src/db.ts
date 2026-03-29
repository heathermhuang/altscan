/**
 * Chain-aware DB singleton for the indexer.
 * All indexer modules should import getDb from here, not from @bnbscan/db directly.
 */
import { getDb as _getDb, schema } from '@bnbscan/db'
import { getChainConfig } from '@bnbscan/chain-config'

const chain = getChainConfig()

export function getDb() {
  return _getDb(chain.dbEnvVar)
}

export { schema }
