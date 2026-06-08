/**
 * Client-safe chain config for 'use client' components.
 * Uses NEXT_PUBLIC_CHAIN env var (inlined at build time by Next.js).
 */
import { getChainConfig, type ChainConfig, type ChainTheme, type ChainFeatures } from '@altscan/chain-config'

export const chainConfig: ChainConfig = getChainConfig(process.env.NEXT_PUBLIC_CHAIN)

// Re-export types for convenience
export type { ChainConfig, ChainTheme, ChainFeatures }
