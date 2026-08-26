/**
 * The single list of endpoints this site advertises publicly.
 *
 * Imported by the RFC 9727 catalog, the agent-skills SKILL.md, the human
 * /api-docs page, and a test that asserts each one has a route handler on disk.
 * Before this existed, those documents were maintained by hand and drifted
 * independently — five advertised endpoints returned 404 on both chains.
 *
 * `routeFile` is only needed when the on-disk path cannot be derived from the
 * advertised path by the ':param' -> '[address]' rule.
 */
export type ApiEndpoint = {
  path: string
  summary: string
  /** Include this endpoint's family as an RFC 9727 linkset anchor. */
  catalogAnchor: boolean
  routeFile?: string
}

export const API_SURFACE: readonly ApiEndpoint[] = [
  { path: '/api/v1/stats', summary: 'network stats (latest block, tx count, token count, avg gas price)', catalogAnchor: true },
  { path: '/api/v1/blocks', summary: 'recent blocks', catalogAnchor: true },
  { path: '/api/v1/blocks/:number', summary: 'one block with txs', catalogAnchor: false, routeFile: 'api/v1/blocks/[number]/route.ts' },
  { path: '/api/v1/transactions', summary: 'recent transactions', catalogAnchor: true },
  { path: '/api/v1/transactions/:hash', summary: 'one transaction with receipt', catalogAnchor: false, routeFile: 'api/v1/transactions/[hash]/route.ts' },
  { path: '/api/v1/addresses/:address', summary: 'address summary (balance, nonce, tx count)', catalogAnchor: false },
  { path: '/api/v1/tokens', summary: 'token list', catalogAnchor: true },
  { path: '/api/v1/tokens/:contract', summary: 'one token (metadata + holder count)', catalogAnchor: false, routeFile: 'api/v1/tokens/[address]/route.ts' },
  { path: '/api/v1/contracts/:address', summary: 'verified-contract metadata', catalogAnchor: false },
]
