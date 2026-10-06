import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdReserve } from '@/components/ads/AdReserve'
import { Badge } from '@/components/ui/Badge'
import { CodeBlock } from '@/components/ui/CodeBlock'
import type { Metadata } from 'next'

export const revalidate = false

export const metadata: Metadata = {
  title: 'Developer Platform',
  description: `Build on ${chainConfig.name} with ${chainConfig.brandDomain}'s REST API, webhooks, and flexible query interface. Free API keys, real-time webhooks, and comprehensive documentation.`,
  alternates: { canonical: '/developer' },
}

const BASE_URL = `https://${chainConfig.domain}`

export default function DeveloperPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 *:max-w-5xl">
      <BreadcrumbJsonLd items={[{ name: 'Developer Platform' }]} />
      <div className="mb-8">
        <p className="k">{'// '}developer</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Developer Platform</h1>
        <p className="mt-2 max-w-3xl text-ink2">
          Build on {chainConfig.name} with {chainConfig.brandName}&apos;s REST API, webhooks, and flexible query interface.
        </p>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
        <a href="/api-docs" className="rounded-xl border border-hair bg-card p-4 transition-colors hover:border-hair3">
          <div className="font-semibold text-ink">API Reference</div>
          <div className="mt-1 text-sm text-ink2">Full endpoint documentation</div>
        </a>
        <a href="#api-keys" className="rounded-xl border border-hair bg-card p-4 transition-colors hover:border-hair3">
          <div className="font-semibold text-ink">API Keys</div>
          <div className="mt-1 text-sm text-ink2">Your own rate-limit bucket</div>
        </a>
        <a href="#webhooks" className="rounded-xl border border-hair bg-card p-4 transition-colors hover:border-hair3">
          <div className="font-semibold text-ink">Webhooks</div>
          <div className="mt-1 text-sm text-ink2">Real-time event notifications</div>
        </a>
      </div>

      <AdReserve
        context="developer"
        placement="developer_after_links"
        variant="compact"
        className="mb-10"
      />

      {/* API Keys Section */}
      <section id="api-keys" className="mb-10">
        <div className="overflow-hidden rounded-xl border border-hair bg-card">
          <div className="flex items-center gap-3 border-b border-hair bg-canvas px-6 py-4">
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">API Keys</h2>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-ink2">
              Requests are limited to <strong>100 req/min per IP</strong>. On the endpoints that take a key
              (query, keys, webhooks, contract call), a request with a valid API key counts against
              that key&apos;s own <strong>100 req/min</strong> instead of your IP&apos;s.
            </p>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Get an API Key</h3>
              <CodeBlock label="Get an API Key">{`# Step 1 — sign a message with your wallet to prove ownership
# Message format (sign this exact string with eth_sign or personal_sign):
#   BNBScan API Key Request
#   Address: 0xyouraddress
#   Timestamp: <unix ms>
#
# Example using ethers.js:
#   const ts = Date.now()
#   const msg = \`BNBScan API Key Request\\nAddress: \${addr.toLowerCase()}\\nTimestamp: \${ts}\`
#   const sig = await signer.signMessage(msg)

# Step 2 — submit the signed request
TS=$(date +%s000)  # current time in milliseconds
SIG="0xYourSignatureHere"

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
}`}</CodeBlock>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Use Your Key</h3>
              <CodeBlock label="Use Your Key">{`# Pass your key via the X-API-Key header (the query endpoint counts it)
curl -X POST ${BASE_URL}/api/v1/query \\
  -H "X-API-Key: bnbs_abc123..." \\
  -H "Content-Type: application/json" \\
  -d '{"entity": "blocks", "limit": 5}'

# List your keys
curl "${BASE_URL}/api/v1/keys?owner=0xYourAddress"`}</CodeBlock>
            </div>

            <dl className="ledger [--cols:2]">
              <div>
                <dt className="k">Anonymous</dt>
                <dd className="mt-1 font-mono text-[15px] text-ink">100 requests/minute per IP</dd>
              </div>
              <div>
                <dt className="k">With API Key</dt>
                <dd className="mt-1 font-mono text-[15px] text-ink">100 requests/minute per key</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Webhooks Section */}
      <section id="webhooks" className="mb-10">
        <div className="overflow-hidden rounded-xl border border-hair bg-card">
          <div className="flex items-center gap-3 border-b border-hair bg-canvas px-6 py-4">
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Webhooks</h2>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-ink2">
              Subscribe to real-time on-chain events. {chainConfig.brandName} will POST to your URL whenever the specified
              events occur for the watched address. Requests are signed with HMAC-SHA256.
            </p>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Register a Webhook</h3>
              <CodeBlock label="Register a Webhook">{`curl -X POST ${BASE_URL}/api/v1/webhooks \\
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
}`}</CodeBlock>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Webhook Payload Format</h3>
              <CodeBlock label="Webhook Payload Format">{`// POST to your URL:
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
// User-Agent: BNBScan-Webhook/1.0`}</CodeBlock>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Verify Signature (Node.js)</h3>
              <CodeBlock label="Verify Signature (Node.js)">{`const crypto = require('crypto')

function verifyWebhook(body, signature, secret) {
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret)
      .update(body)
      .digest('hex')
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  )
}`}</CodeBlock>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Manage Webhooks</h3>
              <CodeBlock label="Manage Webhooks">{`# List your webhooks
curl "${BASE_URL}/api/v1/webhooks?owner=0xYourAddress" \\
  -H "X-API-Key: bnbs_abc123..."

# Delete a webhook
curl -X DELETE ${BASE_URL}/api/v1/webhooks/42 \\
  -H "X-API-Key: bnbs_abc123..."`}</CodeBlock>
            </div>
          </div>
        </div>
      </section>

      {/* Flexible Query API Section */}
      <section id="query" className="mb-10">
        <div className="overflow-hidden rounded-xl border border-hair bg-card">
          <div className="flex items-center gap-3 border-b border-hair bg-canvas px-6 py-4">
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Flexible Query API</h2>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-ink2">
              A single endpoint for querying any entity with flexible filters, ordering, pagination,
              and offset. Ideal for analytics and data pipelines.
            </p>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Endpoint</h3>
              <div className="flex items-center gap-2">
                <Badge variant="pending">POST</Badge>
                <code className="font-mono text-sm font-semibold text-ink">/api/v1/query</code>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Query Transactions by Address</h3>
              <CodeBlock label="Query Transactions by Address">{`curl -X POST ${BASE_URL}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{
    "entity": "transactions",
    "filter": { "address": "0x..." },
    "limit": 50,
    "orderBy": "desc"
  }'`}</CodeBlock>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Query Token Transfers in Block Range</h3>
              <CodeBlock label="Query Token Transfers in Block Range">{`curl -X POST ${BASE_URL}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{
    "entity": "token_transfers",
    "filter": {
      "tokenAddress": "0x...",
      "blockFrom": 42000000,
      "blockTo": 42001000
    },
    "limit": 100
  }'`}</CodeBlock>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Supported Entities &amp; Filters</h3>
              <div
                tabIndex={0}
                role="region"
                aria-label="Supported query entities and their available filters"
                className="overflow-x-auto rounded-lg border border-hair"
              >
              <table className="dt">
                <caption className="sr-only">Supported query entities and their available filters</caption>
                <thead>
                  <tr>
                    <th scope="col">Entity</th>
                    <th scope="col">Available Filters</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-ink">transactions</td>
                    <td className="text-ink2">address, from, to, blockNumber, blockFrom, blockTo</td>
                  </tr>
                  <tr>
                    <td className="text-ink">blocks</td>
                    <td className="text-ink2">blockFrom, blockTo</td>
                  </tr>
                  <tr>
                    <td className="text-ink">tokens</td>
                    <td className="text-ink2">— (ordered by holderCount)</td>
                  </tr>
                  <tr>
                    <td className="text-ink">token_transfers</td>
                    <td className="text-ink2">address, from, to, tokenAddress, blockFrom, blockTo</td>
                  </tr>
                  <tr>
                    <td className="text-ink">dex_trades</td>
                    <td className="text-ink2">address (maker), dex, blockFrom, blockTo</td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>

            <dl className="ledger [--cols:3]">
              <div>
                <dt className="text-xs text-mut">Max limit</dt>
                <dd className="mt-1 font-mono text-[15px] text-ink">100 rows</dd>
              </div>
              <div>
                <dt className="text-xs text-mut">orderBy</dt>
                <dd className="mt-1 font-mono text-[15px] text-ink">&quot;asc&quot; | &quot;desc&quot;</dd>
              </div>
              <div>
                <dt className="text-xs text-mut">offset</dt>
                <dd className="mt-1 font-mono text-[15px] text-ink">integer (pagination)</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <div className="rounded-xl border border-hair bg-card p-6 text-center">
        <h3 className="mb-2 text-lg font-semibold tracking-[-0.02em] text-ink">Ready to build?</h3>
        <p className="mb-4 text-ink2">Get your API key and start querying {chainConfig.name} in minutes.</p>
        <a
          href="/api-docs"
          className="inline-block rounded-[9px] bg-ink px-6 py-2.5 font-semibold text-card transition-opacity hover:opacity-90"
        >
          View Full API Reference →
        </a>
      </div>
    </div>
  )
}
