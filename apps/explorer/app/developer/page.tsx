import { chainConfig } from '@/lib/chain'

export const revalidate = false

const BASE_URL = `https://${chainConfig.domain}`

export default function DeveloperPage() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Developer Platform</h1>
        <p className="text-gray-600 text-lg">
          Build on {chainConfig.name} with {chainConfig.brandName}&apos;s REST API, webhooks, and flexible query interface.
        </p>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
        <a href="/api-docs" className="bg-gray-50 border border-gray-200 rounded-xl p-4 hover:bg-gray-100 transition-colors">
          <div className="font-semibold">API Reference</div>
          <div className="text-sm text-gray-600 mt-1">Full endpoint documentation</div>
        </a>
        <a href="#api-keys" className="bg-gray-50 border border-gray-200 rounded-xl p-4 hover:bg-gray-100 transition-colors">
          <div className="font-semibold">API Keys</div>
          <div className="text-sm text-gray-600 mt-1">Higher rate limits with a key</div>
        </a>
        <a href="#webhooks" className="bg-gray-50 border border-gray-200 rounded-xl p-4 hover:bg-gray-100 transition-colors">
          <div className="font-semibold">Webhooks</div>
          <div className="text-sm text-gray-600 mt-1">Real-time event notifications</div>
        </a>
      </div>

      {/* API Keys Section */}
      <section id="api-keys" className="mb-10">
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50 flex items-center gap-3">
            <h2 className="text-xl font-bold">API Keys</h2>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-gray-700">
              Anonymous requests are rate-limited to <strong>10 req/min per IP</strong>.
              With an API key, you get <strong>100 req/min</strong> — 10x more capacity.
            </p>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Get an API Key</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`# Request a key with your ${chainConfig.currency} address
curl -X POST ${BASE_URL}/api/v1/keys \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"ownerAddress\\": \\"0xYourAddress\\",
    \\"label\\": \\"My App\\",
    \\"signature\\": \\"$SIG\\",
    \\"timestamp\\": $TS
  }"

# Response:
{
  "id": 1,
  "key": "bnbs_abc123...",
  "keyPrefix": "bnbs_abc123",
  "message": "API key created. Save it now — the full key will not be shown again."
}`}</pre>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Use Your Key</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`# Pass your key via the X-API-Key header
curl ${BASE_URL}/api/v1/blocks \\
  -H "X-API-Key: bnbs_abc123..."

# List your keys
curl "${BASE_URL}/api/v1/keys?owner=0xYourAddress"`}</pre>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <div className="font-semibold text-yellow-800 mb-1">Anonymous</div>
                <div className="text-yellow-700">10 requests/minute per IP</div>
              </div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                <div className="font-semibold text-green-800 mb-1">With API Key</div>
                <div className="text-green-700">100 requests/minute</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Webhooks Section */}
      <section id="webhooks" className="mb-10">
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50 flex items-center gap-3">
            <h2 className="text-xl font-bold">Webhooks</h2>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-gray-700">
              Subscribe to real-time on-chain events. {chainConfig.brandName} will POST to your URL whenever the specified
              events occur for the watched address. Requests are signed with HMAC-SHA256.
            </p>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Register a Webhook</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`curl -X POST ${BASE_URL}/api/v1/webhooks \\
  -H "Content-Type: application/json" \\
  -d '{
    "ownerAddress": "0xYourAddress",
    "url": "https://your-app.com/webhook",
    "watchAddress": "0xWatchedAddress",
    "eventTypes": ["tx", "token_transfer"]
  }'

# Response:
{
  "id": 42,
  "secret": "abcdef1234...",
  "message": "Webhook created. Keep the secret..."
}`}</pre>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Webhook Payload Format</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`// POST to your URL:
{
  "event": "tx",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "hash": "0xabc...",
    "from": "0x111...",
    "to": "0x222...",
    "value": "1000000000000000000",
    "blockNumber": 42000000
  }
}

// Headers included:
// X-BNBScan-Signature: sha256=<hmac>
// X-BNBScan-Event: tx
// User-Agent: BNBScan-Webhook/1.0`}</pre>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Verify Signature (Node.js)</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`const crypto = require('crypto')

function verifyWebhook(body, signature, secret) {
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret)
      .update(body)
      .digest('hex')
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  )
}`}</pre>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Manage Webhooks</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`# List your webhooks
curl "${BASE_URL}/api/v1/webhooks?owner=0xYourAddress"

# Delete a webhook
curl -X DELETE ${BASE_URL}/api/v1/webhooks/42`}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* Flexible Query API Section */}
      <section id="query" className="mb-10">
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50 flex items-center gap-3">
            <h2 className="text-xl font-bold">Flexible Query API</h2>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-gray-700">
              A single endpoint for querying any entity with flexible filters, ordering, pagination,
              and offset. Ideal for analytics and data pipelines.
            </p>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Endpoint</h3>
              <div className="flex items-center gap-2">
                <span className="bg-blue-100 text-blue-800 border border-blue-200 px-2 py-0.5 rounded text-xs font-bold font-mono">POST</span>
                <code className="font-mono text-sm font-semibold">/api/v1/query</code>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Query Transactions by Address</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`curl -X POST ${BASE_URL}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{
    "entity": "transactions",
    "filter": { "address": "0x..." },
    "limit": 50,
    "orderBy": "desc"
  }'`}</pre>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Query Token Transfers in Block Range</h3>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-auto leading-relaxed">{`curl -X POST ${BASE_URL}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{
    "entity": "token_transfers",
    "filter": {
      "tokenAddress": "0x...",
      "blockFrom": 42000000,
      "blockTo": 42001000
    },
    "limit": 100
  }'`}</pre>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-3 text-gray-700">Supported Entities &amp; Filters</h3>
              <table className="w-full text-xs border border-gray-200 rounded overflow-hidden">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Entity</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Available Filters</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-3 py-2 font-mono">transactions</td>
                    <td className="px-3 py-2 text-gray-600">address, from, to, blockNumber, blockFrom, blockTo</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-mono">blocks</td>
                    <td className="px-3 py-2 text-gray-600">blockFrom, blockTo</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-mono">tokens</td>
                    <td className="px-3 py-2 text-gray-600">— (ordered by holderCount)</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-mono">token_transfers</td>
                    <td className="px-3 py-2 text-gray-600">address, from, to, tokenAddress, blockFrom, blockTo</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-mono">dex_trades</td>
                    <td className="px-3 py-2 text-gray-600">address (maker), dex, blockFrom, blockTo</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div className="bg-gray-50 border rounded-lg p-3">
                <div className="font-semibold mb-1">Max limit</div>
                <div className="text-gray-600 font-mono">100 rows</div>
              </div>
              <div className="bg-gray-50 border rounded-lg p-3">
                <div className="font-semibold mb-1">orderBy</div>
                <div className="text-gray-600 font-mono">&quot;asc&quot; | &quot;desc&quot;</div>
              </div>
              <div className="bg-gray-50 border rounded-lg p-3">
                <div className="font-semibold mb-1">offset</div>
                <div className="text-gray-600 font-mono">integer (pagination)</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6 text-center">
        <h3 className="font-bold text-lg mb-2">Ready to build?</h3>
        <p className="text-gray-600 mb-4">Get your API key and start querying {chainConfig.name} in minutes.</p>
        <a
          href="/api-docs"
          className={`inline-block px-6 py-2.5 ${chainConfig.theme.buttonBg} hover:opacity-90 rounded-lg font-semibold transition-colors ${chainConfig.theme.buttonText}`}
        >
          View Full API Reference →
        </a>
      </div>
    </div>
  )
}
