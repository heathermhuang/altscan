/**
 * The process-wide resolved config.
 *
 * Split from config.ts so the parser stays pure and importable by tests without
 * touching process.env or resolving a chain. Import `indexerConfig` from here;
 * import the parser from './config'.
 *
 * This module is imported by nearly everything, so it imports as little as
 * possible: config.ts (which imports nothing) and chain-config. An earlier
 * version also pulled in gap-healer and poison-block for their default
 * constants, and that cycle crashed the process at boot — passing typecheck and
 * the whole test suite on the way.
 */
import { getChainConfig } from '@altscan/chain-config'
import { readIndexerConfig, formatResolvedConfig } from './config'

const chain = getChainConfig()

const resolved = readIndexerConfig(process.env, {
  startBlock: chain.defaultStartBlock,
  // BNB produces a block every 3s and needs the workers; ETH at 12s can run lower.
  concurrency: chain.key === 'bnb' ? 8 : 4,
  // ~half a day of BSC blocks (the deployed PARTITION_BLOCKS) / ~one day of ETH
  // blocks. The 192_000 token_transfers default is 27 days on ETH — wider than
  // the retention window, so every partition would straddle the cutoff and
  // retention would never drop one.
  internalTxPartitionBlocks: chain.key === 'bnb' ? 96_000 : 7_200,
  reorgDepth: chain.reorgDepth,
  // BNB's 0.45s blocks need the async transfer writer; ETH's 12s blocks are fine inline.
  asyncTransferWriter: chain.key === 'bnb',
})

export const indexerConfig = resolved.config
const configResolutions = resolved.resolutions

/** Call once at boot, before anything reads config, so the log records what this
 *  process is actually running with rather than what the repo says it should. */
export function logResolvedConfig(): void {
  for (const line of formatResolvedConfig(configResolutions)) console.log(line)
}
