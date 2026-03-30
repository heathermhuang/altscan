/**
 * Chain-aware name resolver dispatcher.
 * Uses ENS for Ethereum, Space ID for BNB Chain.
 */
import { chainConfig } from './chain'
import { resolveEns, resolveEnsToAddress } from './resolvers/ens'
import { resolveSpaceId } from './resolvers/spaceid'

export async function resolveName(address: string): Promise<string | null> {
  if (chainConfig.features.hasEns) {
    return resolveEns(address)
  }
  return resolveSpaceId(address)
}

export async function resolveNameToAddress(name: string): Promise<string | null> {
  if (chainConfig.features.hasEns) {
    return resolveEnsToAddress(name)
  }
  return null
}
