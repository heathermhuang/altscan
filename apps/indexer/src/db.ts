/**
 * Chain-aware DB singleton for the indexer.
 * All indexer modules should import getDb from here, not from @altscan/db directly.
 */
import { getDb as _getDb, getMaintenanceDb as _getMaintenanceDb, schema } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'

const chain = getChainConfig()

export function getDb() {
  return _getDb(chain.dbEnvVar)
}

// Dedicated, isolated pool for background maintenance (retention deletes,
// holder-count recompute) so those jobs never occupy the ingestion pool's slots.
export function getMaintenanceDb() {
  return _getMaintenanceDb(chain.dbEnvVar)
}

export { schema }
