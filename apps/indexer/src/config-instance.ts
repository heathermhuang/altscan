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
})

export const indexerConfig = resolved.config
export const configResolutions = resolved.resolutions

/** Call once at boot, before anything reads config, so the log records what this
 *  process is actually running with rather than what the repo says it should. */
export function logResolvedConfig(): void {
  for (const line of formatResolvedConfig(configResolutions)) console.log(line)
}
