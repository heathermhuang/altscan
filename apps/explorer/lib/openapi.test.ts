import { describe, it, expect } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { Validator } from '@seriousme/openapi-schema-validator'
import { CHAINS } from '@altscan/chain-config'
import type { schema } from '@altscan/db'
import { API_SURFACE } from '@/lib/api-surface'
import { serializeBigInt } from '@/lib/api-serialize'
import type { RpcTxFacts } from '@/lib/rpc-fallback'
import type { Lookalike } from '@/lib/lookalike'
import { OPENAPI_MEDIA_TYPE, OPERATIONS, buildOpenApi, openApiPath } from '@/lib/openapi'
import { chainConfig } from '@/lib/chain'
import { GET as openApiRoute } from '@/app/openapi.json/route'
import { GET as apiCatalog } from '@/app/.well-known/api-catalog/route'

const spec = buildOpenApi(CHAINS.bnb)
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)

describe('openapi spec', () => {
  it.each(Object.values(CHAINS))('validates as OpenAPI 3.1 for $key', async (c) => {
    const res = await new Validator().validate(buildOpenApi(c))
    expect(res.errors ?? []).toEqual([])
    expect(res.valid).toBe(true)
  })

  // The guard against drift: the spec documents exactly what API_SURFACE advertises.
  // The OpenAPI validator checks the document's structure, not the keywords inside its schemas.
  it('every schema in it is valid JSON Schema 2020-12', () => {
    const ops = Object.values(spec.paths).map(i => i.get as { parameters?: { schema: object }[]; responses: Record<string, { content: { 'application/json': { schema: object } } }> })
    const schemas = [
      ...Object.values(spec.components.schemas),
      ...ops.flatMap(o => (o.parameters ?? []).map(p => p.schema)),
      ...ops.flatMap(o => Object.values(o.responses).map(r => r.content['application/json'].schema)),
    ]
    expect(schemas.length).toBeGreaterThan(40)
    for (const s of schemas) expect(ajv.validateSchema(s), JSON.stringify(ajv.errors)).toBe(true)
  })

  it('has exactly the API_SURFACE paths, in order', () => {
    expect(Object.keys(spec.paths)).toEqual(API_SURFACE.map(e => openApiPath(e.path)))
    expect(Object.keys(OPERATIONS).sort()).toEqual(API_SURFACE.map(e => e.path).sort())
  })

  it('is served at /openapi.json and linked from every RFC 9727 catalog entry', async () => {
    const res = await openApiRoute()
    expect(res.headers.get('content-type')).toBe(OPENAPI_MEDIA_TYPE)
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApi(chainConfig))))
    const { linkset } = await (await apiCatalog()).json()
    for (const entry of linkset) {
      expect(entry['service-desc']).toEqual([{ href: `https://${chainConfig.domain}/openapi.json`, type: OPENAPI_MEDIA_TYPE }])
    }
  })

  it.each(Object.entries(spec.paths))('%s declares exactly its path placeholders', (path, item) => {
    const placeholders = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1])
    const declared = ((item.get.parameters ?? []) as { name: string; in: string }[])
      .filter(p => p.in === 'path').map(p => p.name)
    expect(declared).toEqual(placeholders)
  })
})

// Rows typed by the Drizzle schema and RpcTxFacts, serialized the way apiJson() does, must match
// the documented 200 bodies. A new column fails `next build` here until the fixture (and so the
// key check below) is updated.
const H = '0x' + 'ab'.repeat(32)
const A = '0x' + '12'.repeat(20)
const T = new Date('2026-10-19T13:09:51.000Z')

const block: typeof schema.blocks.$inferSelect = {
  number: 128559762, hash: H, parentHash: H, timestamp: T, miner: A,
  gasUsed: 18211059n, gasLimit: 70000000n, baseFeePerGas: '0', txCount: 101, size: 0,
}
const indexedTx: typeof schema.transactions.$inferSelect = {
  hash: H, blockNumber: 128559762, fromAddress: A, toAddress: null, value: '31337.000000000000000000',
  gas: 9223372036854775807n, gasPrice: '50000000', gasUsed: 55345n, input: '0xf340fa01', status: true,
  methodId: '0xf340fa01', txIndex: 87, nonce: 3809985, txType: 0, timestamp: T, bodyPruned: false,
}
const chainTx: RpcTxFacts = {
  hash: H, blockNumber: 46147, fromAddress: A, toAddress: A, value: 31337n, gas: 21000n,
  gasPrice: 50000000000000n, gasUsed: 21000n, input: '0x', status: true, pending: false,
  methodId: null, txIndex: 0, nonce: 0, txType: 0, timestamp: T,
}
const pendingTx: RpcTxFacts = {
  ...chainTx, blockNumber: null, gasUsed: null, status: null, pending: true, txIndex: null, timestamp: null,
}
const transfer: typeof schema.tokenTransfers.$inferSelect = {
  txHash: H, logIndex: 2379, tokenAddress: A, fromAddress: A, toAddress: A, value: '36719622533372',
  tokenId: null, blockNumber: 128556196, timestamp: T,
}
const token: typeof schema.tokens.$inferSelect = {
  address: A, name: 'Tether USD', symbol: 'USDT', decimals: 18, type: 'BEP20',
  totalSupply: '9184991859680809663064697687', holderCount: 835871, logoUrl: null,
}
const lookalike: Lookalike = { symbol: 'USDT', canonical: A }
// The route selects these columns explicitly (no bytecode or source).
const contract: Pick<typeof schema.contracts.$inferSelect, 'address' | 'abi' | 'compilerVersion' | 'verifiedAt' | 'verifySource' | 'license'> = {
  address: A, abi: [], compilerVersion: '0.4.18+commit.9cf6e910', verifiedAt: T, verifySource: 'sourcify', license: null,
}
const stats = {
  latestBlock: 128559763, totalTransactions: 33579496, totalTokens: 4654853, avgGasPrice: '50000000',
  latestBlockStr: '128559763', totalTransactionsStr: '33579496',
}

const responses = (path: string) =>
  (spec.paths[openApiPath(path)].get.responses as Record<string, { content: { 'application/json': { schema: object } } }>)
const validate200 = (path: string, body: unknown) => {
  const check = ajv.compile({ ...responses(path)[200].content['application/json'].schema, components: spec.components })
  return check(serializeBigInt(body)) ? [] : check.errors
}

describe('documented 200 bodies match what the routes return', () => {
  it.each<[string, unknown]>([
    ['/api/v1/stats', stats],
    ['/api/v1/stats', { latestBlock: 0, totalTransactions: 0, totalTokens: 0, avgGasPrice: '0' }],
    ['/api/v1/blocks', { blocks: [block], total: 1, page: 1, limit: 20 }],
    ['/api/v1/blocks/:number', { block }],
    ['/api/v1/blocks/:number', { block: { ...block, baseFeePerGas: null } }],
    ['/api/v1/transactions', { transactions: [indexedTx], total: 1, page: 1, limit: 20 }],
    ['/api/v1/transactions/:hash', { transaction: indexedTx, source: 'index' }],
    ['/api/v1/transactions/:hash', { transaction: chainTx, source: 'chain' }],
    ['/api/v1/transactions/:hash', { transaction: pendingTx, source: 'chain' }],
    ['/api/v1/addresses/:address', { transactions: [indexedTx], tokenTransfers: [transfer], isContract: true, isContractKnown: true }],
    ['/api/v1/tokens', { tokens: [token], total: 1 }],
    ['/api/v1/tokens/:contract', { token, lookalike }],
    ['/api/v1/tokens/:contract', { token, lookalike: null }],
    ['/api/v1/tokens/:contract', { token, lookalike: { symbol: 'BNB', canonical: null } }],
    ['/api/v1/contracts/:address', { contract }],
  ])('%s', (path, body) => {
    expect(validate200(path, body)).toEqual([])
  })

  // Proof the check can fail.
  it('rejects an unserialized bigint, a chain row labelled index, and a missing field', () => {
    const raw = ajv.compile({ ...responses('/api/v1/blocks/:number')[200].content['application/json'].schema, components: spec.components })
    expect(raw({ block })).toBe(false)
    expect(validate200('/api/v1/transactions/:hash', { transaction: chainTx, source: 'index' })).not.toEqual([])
    const { lookalike: _drop, ...noLookalike } = { token, lookalike }
    expect(validate200('/api/v1/tokens/:contract', noLookalike)).not.toEqual([])
  })

  it.each<[string, object]>([
    ['Block', block], ['IndexedTransaction', indexedTx], ['ChainTransaction', chainTx],
    ['TokenTransfer', transfer], ['Token', token], ['Lookalike', lookalike], ['Contract', contract], ['Stats', stats],
  ])('%s documents exactly the fields the route returns', (name, row) => {
    const documented = (spec.components.schemas[name] as { properties: object }).properties
    expect(Object.keys(documented).sort()).toEqual(Object.keys(row).sort())
  })
})
