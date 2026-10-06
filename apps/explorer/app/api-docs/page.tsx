import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdReserve } from '@/components/ads/AdReserve'
import { Badge } from '@/components/ui/Badge'
import { CodeBlock } from '@/components/ui/CodeBlock'
import type { Metadata } from 'next'

export const revalidate = false

export const metadata: Metadata = {
  title: `API Documentation`,
  description: `${chainConfig.brandDomain} REST API documentation. Query blocks, transactions, tokens, and addresses on ${chainConfig.name} programmatically.`,
  alternates: { canonical: '/api-docs' },
}

type Param = {
  name: string
  type: string
  required?: boolean
  description: string
}

type Endpoint = {
  method: 'GET' | 'POST'
  path: string
  description: string
  params?: Param[]
  exampleResponse: string
}

const endpoints: Endpoint[] = [
  {
    method: 'GET',
    path: '/api/v1/stats',
    description: 'Returns high-level network statistics including the latest block number, total transaction count, total token count, and average gas price.',
    params: [],
    exampleResponse: JSON.stringify(
      {
        latestBlock: 42000000,
        totalTransactions: 1500000,
        totalTokens: 3200,
        avgGasPrice: '5000000000',
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/blocks',
    description: 'Returns a paginated list of blocks ordered by block number descending.',
    params: [
      { name: 'page', type: 'number', description: 'Page number, starting from 1 (default: 1)' },
      { name: 'limit', type: 'number', description: 'Number of results per page (default: 25, max: 100)' },
    ],
    exampleResponse: JSON.stringify(
      {
        blocks: [
          {
            number: 42000000,
            hash: '0xabc123...',
            timestamp: '2024-01-01T00:00:00Z',
            miner: '0xdef456...',
            txCount: 120,
            gasUsed: '8000000',
            gasLimit: '10000000',
          },
        ],
        total: 42000000,
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/transactions',
    description: 'Returns a paginated list of recent transactions, ordered by block number and transaction index, descending.',
    params: [
      { name: 'page', type: 'number', description: 'Page number, starting from 1 (default: 1)' },
      { name: 'limit', type: 'number', description: 'Number of results per page (default: 20, max: 50)' },
    ],
    exampleResponse: JSON.stringify(
      {
        transactions: [
          {
            hash: '0x123abc...',
            blockNumber: 42000000,
            fromAddress: '0xaaa...',
            toAddress: '0xbbb...',
            value: '1000000000000000000',
            gasPrice: '5000000000',
            gasUsed: '21000',
            status: true,
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1500000,
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/tokens',
    description: 'Returns a paginated list of BEP20/BEP721/BEP1155 tokens tracked by the indexer.',
    params: [
      { name: 'page', type: 'number', description: 'Page number, starting from 1 (default: 1)' },
      { name: 'limit', type: 'number', description: 'Number of results per page (default: 25, max: 100)' },
    ],
    exampleResponse: JSON.stringify(
      {
        tokens: [
          {
            address: '0xccc...',
            name: 'Example Token',
            symbol: 'EXT',
            decimals: 18,
            type: 'BEP20',
            totalSupply: '1000000000000000000000000',
            holderCount: 12500,
          },
        ],
        total: 3200,
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/addresses/:address',
    description:
      'Returns an address\u2019s most recent transactions and token transfers, plus whether it is a contract. ' +
      'isContractKnown is false only when contract status could not be determined at all \u2014 the code lookup failed AND the address is not in the verification registry. Treat isContract as unknown, not false, in that case.',
    params: [
      { name: 'address', type: 'string', required: true, description: 'The Ethereum/BNB address (0x-prefixed, 42 chars). Case-insensitive.' },
    ],
    exampleResponse: JSON.stringify(
      {
        transactions: [
          {
            hash: '0xabc...',
            blockNumber: 41234567,
            fromAddress: '0xddd...',
            toAddress: '0xeee...',
            value: '5000000000000000000',
            gasUsed: '21000',
            status: true,
            timestamp: '2024-01-01T00:00:00Z',
            bodyPruned: false,
          },
        ],
        tokenTransfers: [],
        isContract: false,
        isContractKnown: true,
      },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/verify',
    description: 'Submit a smart contract for source code verification. The contract bytecode must already be indexed. Supports compiler version specification and license type.',
    params: [
      { name: 'address', type: 'string', required: true, description: 'Contract address to verify (0x-prefixed)' },
      { name: 'sourceCode', type: 'string', required: true, description: 'Full Solidity source code' },
      { name: 'compilerVersion', type: 'string', required: true, description: 'Solidity compiler version (e.g. 0.8.19)' },
      { name: 'license', type: 'string', required: false, description: 'SPDX license identifier (e.g. MIT, Apache-2.0)' },
    ],
    exampleResponse: JSON.stringify(
      {
        success: true,
        message: 'Contract verified successfully',
        address: '0xeee...',
      },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/contracts/:address/call',
    description: 'Call a read-only (view/pure) function on a verified contract using its ABI. Returns the result with BigInt values serialized as strings.',
    params: [
      { name: 'address', type: 'string', required: true, description: 'Contract address (must be verified with ABI)' },
      { name: 'functionName', type: 'string', required: true, description: 'Name of the view/pure function to call' },
      { name: 'args', type: 'array', required: false, description: 'Array of arguments to pass to the function' },
    ],
    exampleResponse: JSON.stringify(
      { result: '1000000000000000000' },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/webhooks',
    description: 'List all webhooks registered to an owner address.',
    params: [
      { name: 'owner', type: 'string', required: true, description: 'Owner BNB address (0x-prefixed)' },
    ],
    exampleResponse: JSON.stringify(
      {
        webhooks: [
          {
            id: 1,
            url: 'https://your-app.com/webhook',
            watchAddress: '0xabc...',
            eventTypes: ['tx', 'token_transfer'],
            active: true,
            createdAt: '2024-01-01T00:00:00Z',
            lastTriggeredAt: null,
            failCount: 0,
          },
        ],
      },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/webhooks',
    description: `Register a new webhook. Returns a one-time secret for verifying incoming webhook signatures (HMAC-SHA256). ${chainConfig.brandName} will POST events to your URL with an X-BNBScan-Signature header.`,
    params: [
      { name: 'ownerAddress', type: 'string', required: true, description: 'Your BNB address (0x-prefixed)' },
      { name: 'url', type: 'string', required: true, description: 'Your HTTPS endpoint to receive events' },
      { name: 'watchAddress', type: 'string', required: false, description: 'Address to watch for events' },
      { name: 'eventTypes', type: 'string[]', required: false, description: 'Event types: ["tx", "token_transfer"] (default: ["tx"])' },
    ],
    exampleResponse: JSON.stringify(
      {
        id: 1,
        secret: 'abc123...',
        message: 'Webhook created. Keep the secret — it will not be shown again.',
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/keys',
    description: 'List API keys for an owner address. Key hashes are never returned — only the prefix for identification.',
    params: [
      { name: 'owner', type: 'string', required: true, description: 'Owner BNB address (0x-prefixed)' },
    ],
    exampleResponse: JSON.stringify(
      {
        keys: [
          {
            id: 1,
            keyPrefix: 'bnbs_abc123',
            label: 'My App',
            requestsPerMinute: 100,
            totalRequests: 5420,
            createdAt: '2024-01-01T00:00:00Z',
            lastUsedAt: '2024-01-10T12:00:00Z',
            active: true,
          },
        ],
      },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/keys',
    description: 'Generate a new API key linked to your BNB address. The full key is shown once — save it immediately. Use the X-API-Key header to authenticate requests.',
    params: [
      { name: 'ownerAddress', type: 'string', required: true, description: 'Your BNB address (0x-prefixed)' },
      { name: 'label', type: 'string', required: false, description: 'Human-readable label for this key' },
    ],
    exampleResponse: JSON.stringify(
      {
        id: 1,
        key: 'bnbs_abc123...',
        keyPrefix: 'bnbs_abc123',
        message: 'API key created. Save it now — the full key will not be shown again.',
      },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/query',
    description: 'Flexible query endpoint for fetching any entity with filters, ordering, and pagination. Supports: transactions, blocks, tokens, token_transfers, dex_trades.',
    params: [
      { name: 'entity', type: 'string', required: true, description: 'One of: transactions, blocks, tokens, token_transfers, dex_trades' },
      { name: 'filter', type: 'object', required: false, description: 'Filter object: { address, from, to, blockNumber, blockFrom, blockTo, tokenAddress, dex }' },
      { name: 'orderBy', type: 'string', required: false, description: '"asc" or "desc" (default: "desc")' },
      { name: 'limit', type: 'number', required: false, description: 'Number of results (default: 25, max: 100)' },
      { name: 'offset', type: 'number', required: false, description: 'Pagination offset (default: 0)' },
    ],
    exampleResponse: JSON.stringify(
      {
        entity: 'transactions',
        count: 25,
        data: [
          {
            hash: '0x123...',
            blockNumber: 42000000,
            fromAddress: '0xaaa...',
            toAddress: '0xbbb...',
            value: '1000000000000000000',
          },
        ],
      },
      null,
      2
    ),
  },
]

export default function ApiDocsPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 *:max-w-5xl">
      <BreadcrumbJsonLd items={[{ name: 'API Documentation' }]} />
      <div className="mb-8">
        <p className="k">{'// '}api</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">API Reference</h1>
        <p className="mt-2 text-ink2">
          {chainConfig.brandName} provides a public REST API for accessing {chainConfig.name} block explorer data.
          All endpoints return JSON. Base URL:{' '}
          <code className="rounded-[4px] bg-hair2 px-1.5 py-0.5 font-mono text-sm text-ink">
            https://{chainConfig.domain}
          </code>
        </p>
        <div className="mt-4 rounded-xl border border-hair border-l-[3px] border-l-acc bg-card px-4 py-3 text-sm text-ink2">
          <strong className="text-ink">Rate Limiting:</strong> API requests are limited to 100 requests per minute per IP address (10 per minute for{' '}
          <code className="font-mono text-ink">POST /api/v1/verify</code>). On the endpoints that take a key (query, keys, webhook creation, contract call), a request with a valid{' '}
          <code className="font-mono text-ink">X-API-Key</code> counts against that key&apos;s own limit, 100 requests per minute, instead of the IP&apos;s. Over a limit the API answers 429.
        </div>
      </div>

      <AdReserve
        context="api_docs"
        placement="api_docs_intro"
        variant="compact"
        className="mb-8"
      />

      <div className="space-y-6">
        {endpoints.map((ep) => (
          <EndpointCard key={`${ep.method} ${ep.path}`} endpoint={ep} />
        ))}
      </div>
    </div>
  )
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  return (
    <div className="overflow-hidden rounded-xl border border-hair bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
        <Badge variant={endpoint.method === 'GET' ? 'success' : 'pending'}>{endpoint.method}</Badge>
        <h2 className="min-w-0">
          <code className="break-all font-mono text-sm font-semibold text-ink">{endpoint.path}</code>
        </h2>
      </div>

      {/* Body */}
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-ink2">{endpoint.description}</p>

        {endpoint.params && endpoint.params.length > 0 && (
          <div>
            <h3 className="k mb-2">Parameters</h3>
            <div
              tabIndex={0}
              role="region"
              aria-label={`Parameters for ${endpoint.method} ${endpoint.path}`}
              className="dt-x fade-r overflow-x-auto rounded-lg border border-hair"
            >
            <table className="dt min-w-[36rem]">
              <caption className="sr-only">Parameters for {endpoint.method} {endpoint.path}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Required</th>
                  <th scope="col">Description</th>
                </tr>
              </thead>
              <tbody>
                {endpoint.params.map((p) => (
                  <tr key={p.name}>
                    <td className="text-ink">{p.name}</td>
                    <td className="text-mut">{p.type}</td>
                    <td>
                      {p.required ? (
                        <span className="font-medium text-warn">Yes</span>
                      ) : (
                        <span className="text-mut">No</span>
                      )}
                    </td>
                    <td className="font-sans text-ink2">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        <details className="group">
          <summary className="flex cursor-pointer list-none select-none items-center gap-1 text-sm font-medium text-acc-ink hover:underline">
            <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
            Example Response
          </summary>
          <div className="mt-2">
            <CodeBlock label={`Example response for ${endpoint.method} ${endpoint.path}`}>{endpoint.exampleResponse}</CodeBlock>
          </div>
        </details>
      </div>
    </div>
  )
}
