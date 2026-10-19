import { NextResponse } from 'next/server'

// MCP Server Card (SEP-1649) for the MCP server that serves this explorer's data.
// The server runs at altscan.io/mcp and covers both chains, so this is the same
// card altscan.io publishes; lib/agent-discovery.test.ts keeps the two identical.

export const revalidate = 3600

const SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'io.altscan/explorers',
  version: '0.1.0',
  title: 'Altscan explorers',
  description:
    'Read-only, keyless access to BNB Chain and Ethereum data from Altscan\'s open-source explorers (BNBScan, EthScan): transactions by hash, including ones older than the index, and token contracts with a lookalike check against well-known tokens.',
  websiteUrl: 'https://altscan.io',
  repository: { url: 'https://github.com/heathermhuang/altscan', source: 'github' },
  remotes: [{ type: 'streamable-http', url: 'https://altscan.io/mcp' }],
}

export async function GET() {
  return NextResponse.json(SERVER_CARD, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
