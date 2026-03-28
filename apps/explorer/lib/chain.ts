import { getChainConfig } from '@bnbscan/chain-config'

/** Resolved once at module load time. Use CHAIN env var to select chain. */
export const chainConfig = getChainConfig()
