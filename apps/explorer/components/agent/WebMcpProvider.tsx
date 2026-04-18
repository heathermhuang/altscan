'use client'

import { useEffect } from 'react'
import { chainConfig } from '@/lib/chain'

/**
 * WebMCP (https://webmachinelearning.github.io/webmcp/) — exposes a small
 * set of read-only navigation/lookup tools to an in-browser AI agent via
 * `navigator.modelContext.provideContext()`.
 *
 * All tools resolve by navigating the user to the appropriate explorer page;
 * they do NOT hit the API from the browser, and they do NOT accept any
 * destructive inputs (this is a public read-only explorer). If the API is
 * not available (most current browsers) we silently no-op.
 */

type ToolDef = {
  name: string
  description: string
  inputSchema: unknown
  execute: (args: unknown) => Promise<unknown>
}

type ModelContext = {
  provideContext(ctx: { tools: ToolDef[] }): void | Promise<void>
}

function hasModelContext(nav: Navigator): nav is Navigator & { modelContext: ModelContext } {
  return typeof (nav as unknown as { modelContext?: unknown }).modelContext === 'object'
}

function isHexHash(s: unknown, length: 40 | 64): boolean {
  return typeof s === 'string' && new RegExp(`^0x[0-9a-fA-F]{${length}}$`).test(s)
}

export function WebMcpProvider() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !hasModelContext(navigator)) return

    const brand = chainConfig.brandDomain
    const chain = chainConfig.name

    const tools: ToolDef[] = [
      {
        name: 'open_transaction',
        description: `Open a ${chain} transaction by its 66-character hex hash on ${brand}.`,
        inputSchema: {
          type: 'object',
          required: ['hash'],
          additionalProperties: false,
          properties: {
            hash: {
              type: 'string',
              pattern: '^0x[0-9a-fA-F]{64}$',
              description: 'Transaction hash (0x + 64 hex chars).',
            },
          },
        },
        execute: async (raw) => {
          const args = raw as { hash?: string } | undefined
          if (!args || !isHexHash(args.hash, 64)) throw new Error('Invalid transaction hash.')
          window.location.assign(`/tx/${args.hash}`)
          return { navigatedTo: `/tx/${args.hash}` }
        },
      },
      {
        name: 'open_address',
        description: `Open a ${chain} address (EOA or contract) on ${brand}.`,
        inputSchema: {
          type: 'object',
          required: ['address'],
          additionalProperties: false,
          properties: {
            address: {
              type: 'string',
              pattern: '^0x[0-9a-fA-F]{40}$',
              description: 'Address (0x + 40 hex chars).',
            },
          },
        },
        execute: async (raw) => {
          const args = raw as { address?: string } | undefined
          if (!args || !isHexHash(args.address, 40)) throw new Error('Invalid address.')
          window.location.assign(`/address/${args.address}`)
          return { navigatedTo: `/address/${args.address}` }
        },
      },
      {
        name: 'open_block',
        description: `Open a ${chain} block by decimal block number on ${brand}.`,
        inputSchema: {
          type: 'object',
          required: ['number'],
          additionalProperties: false,
          properties: {
            number: {
              type: 'integer',
              minimum: 0,
              description: 'Block number (non-negative integer).',
            },
          },
        },
        execute: async (raw) => {
          const args = raw as { number?: number } | undefined
          const n = args?.number
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
            throw new Error('Invalid block number.')
          }
          window.location.assign(`/block/${n}`)
          return { navigatedTo: `/block/${n}` }
        },
      },
      {
        name: 'search',
        description: `Run a ${brand} search by hash, address, ENS name, block number, or token symbol.`,
        inputSchema: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
        execute: async (raw) => {
          const args = raw as { query?: string } | undefined
          const q = args?.query?.trim()
          if (!q) throw new Error('Empty query.')
          const url = `/search?q=${encodeURIComponent(q)}`
          window.location.assign(url)
          return { navigatedTo: url }
        },
      },
    ]

    try {
      void navigator.modelContext.provideContext({ tools })
    } catch {
      // Browser may reject (e.g. permission policy); fail quietly.
    }
  }, [])

  return null
}
