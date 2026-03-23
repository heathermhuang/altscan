export const revalidate = false

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
        latestBlock: 20000000,
        totalTransactions: 2500000000,
        totalTokens: 12000,
        avgGasPrice: '12000000000',
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
            number: 20000000,
            hash: '0xabc123...',
            timestamp: '2024-07-01T00:00:00Z',
            miner: '0xdef456...',
            txCount: 180,
            gasUsed: '15000000',
            gasLimit: '30000000',
          },
        ],
        total: 20000000,
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/transactions',
    description: 'Returns a paginated list of transactions. Optionally filter by address.',
    params: [
      { name: 'page', type: 'number', description: 'Page number, starting from 1 (default: 1)' },
      { name: 'limit', type: 'number', description: 'Number of results per page (default: 25, max: 100)' },
      { name: 'address', type: 'string', required: false, description: 'Filter by from or to address (e.g. 0x...)' },
    ],
    exampleResponse: JSON.stringify(
      {
        transactions: [
          {
            hash: '0x123abc...',
            blockNumber: 20000000,
            fromAddress: '0xaaa...',
            toAddress: '0xbbb...',
            value: '1000000000000000000',
            gasPrice: '12000000000',
            gasUsed: '21000',
            status: true,
            timestamp: '2024-07-01T00:00:00Z',
          },
        ],
        total: 2500000000,
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/tokens',
    description: 'Returns a paginated list of ERC-20/ERC-721/ERC-1155 tokens tracked by the indexer.',
    params: [
      { name: 'page', type: 'number', description: 'Page number, starting from 1 (default: 1)' },
      { name: 'limit', type: 'number', description: 'Number of results per page (default: 25, max: 100)' },
    ],
    exampleResponse: JSON.stringify(
      {
        tokens: [
          {
            address: '0xccc...',
            name: 'Tether USD',
            symbol: 'USDT',
            decimals: 6,
            type: 'ERC20',
            totalSupply: '83000000000000',
            holderCount: 5200000,
          },
        ],
        total: 12000,
      },
      null,
      2
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/addresses/:address',
    description: 'Returns detailed information about an address including balance, transaction count, contract status, and recent transactions.',
    params: [
      { name: 'address', type: 'string', required: true, description: 'The Ethereum address (0x-prefixed, 42 chars)' },
    ],
    exampleResponse: JSON.stringify(
      {
        address: '0xddd...',
        balance: '5000000000000000000',
        txCount: 42,
        isContract: false,
        label: null,
        firstSeen: '2022-01-01T00:00:00Z',
        lastSeen: '2024-07-01T00:00:00Z',
        recentTxs: [],
      },
      null,
      2
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/verify',
    description: 'Submit a smart contract for source code verification. The contract bytecode must already be indexed. Checks Sourcify for existing verifications on Ethereum Mainnet (chain ID 1).',
    params: [
      { name: 'address', type: 'string', required: true, description: 'Contract address to verify (0x-prefixed)' },
      { name: 'compilerVersion', type: 'string', required: true, description: 'Solidity compiler version (e.g. v0.8.19+commit.7dd6d404)' },
    ],
    exampleResponse: JSON.stringify(
      {
        success: true,
        match: 'sourcify',
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
      { name: 'owner', type: 'string', required: true, description: 'Owner Ethereum address (0x-prefixed)' },
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
    description: 'Register a new webhook. Returns a one-time secret for verifying incoming webhook signatures (HMAC-SHA256). EthScan will POST events to your URL with an X-EthScan-Signature header.',
    params: [
      { name: 'ownerAddress', type: 'string', required: true, description: 'Your Ethereum address (0x-prefixed)' },
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
      { name: 'owner', type: 'string', required: true, description: 'Owner Ethereum address (0x-prefixed)' },
    ],
    exampleResponse: JSON.stringify(
      {
        keys: [
          {
            id: 1,
            keyPrefix: 'eths_abc123',
            label: 'My App',
            requestsPerMinute: 100,
            totalRequests: 5420,
            createdAt: '2024-01-01T00:00:00Z',
            lastUsedAt: '2024-07-01T12:00:00Z',
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
    description: 'Generate a new API key linked to your Ethereum address. The full key is shown once — save it immediately. Use the X-API-Key header to authenticate requests.',
    params: [
      { name: 'ownerAddress', type: 'string', required: true, description: 'Your Ethereum address (0x-prefixed)' },
      { name: 'label', type: 'string', required: false, description: 'Human-readable label for this key' },
    ],
    exampleResponse: JSON.stringify(
      {
        id: 1,
        key: 'eths_abc123...',
        keyPrefix: 'eths_abc123',
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
            blockNumber: 20000000,
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
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">API Reference</h1>
        <p className="text-gray-600">
          EthScan provides a public REST API for accessing Ethereum block explorer data.
          All endpoints return JSON. Base URL:{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">
            https://ethscan.io
          </code>
        </p>
        <div className="mt-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-900">
          <strong>Rate Limiting:</strong> API requests are rate-limited to 100 requests per minute per IP address. Responses include{' '}
          <code className="font-mono">X-RateLimit-Remaining</code> headers.
        </div>
      </div>

      <div className="space-y-6">
        {endpoints.map((ep) => (
          <EndpointCard key={ep.path} endpoint={ep} />
        ))}
      </div>
    </div>
  )
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const methodColor =
    endpoint.method === 'GET'
      ? 'bg-green-100 text-green-800 border border-green-200'
      : 'bg-blue-100 text-blue-800 border border-blue-200'

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
        <span className={`px-2.5 py-1 rounded text-xs font-bold font-mono ${methodColor}`}>
          {endpoint.method}
        </span>
        <code className="font-mono text-sm font-semibold text-gray-900">{endpoint.path}</code>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        <p className="text-sm text-gray-700">{endpoint.description}</p>

        {endpoint.params && endpoint.params.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Parameters
            </h3>
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600 text-xs">Name</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600 text-xs">Type</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600 text-xs">Required</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600 text-xs">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {endpoint.params.map((p) => (
                  <tr key={p.name} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs text-gray-900">{p.name}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{p.type}</td>
                    <td className="px-3 py-2 text-xs">
                      {p.required ? (
                        <span className="text-red-600 font-medium">Yes</span>
                      ) : (
                        <span className="text-gray-400">No</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-indigo-700 hover:text-indigo-900 select-none list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
            Example Response
          </summary>
          <pre className="mt-2 bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-auto leading-relaxed">
            {endpoint.exampleResponse}
          </pre>
        </details>
      </div>
    </div>
  )
}
