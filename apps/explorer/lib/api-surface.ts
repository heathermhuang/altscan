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
  { path: '/api/v1/blocks/:number', summary: 'one block (its transactions are not included)', catalogAnchor: false, routeFile: 'api/v1/blocks/[number]/route.ts' },
  { path: '/api/v1/transactions', summary: 'recent transactions', catalogAnchor: true },
  { path: '/api/v1/transactions/:hash', summary: 'one transaction with its status and gas used (no logs); outside the index it is read from the chain: `source` says which, `pending` means no receipt yet, unknown fields are null, 503 means retry', catalogAnchor: false, routeFile: 'api/v1/transactions/[hash]/route.ts' },
  { path: '/api/v1/addresses/:address', summary: 'the address\'s 20 latest indexed transactions and token transfers; whether it is a contract (undetermined when isContractKnown is false); `historyComplete`: false means it has activity older than `indexedFrom` that the index no longer holds, so empty lists do not mean no activity (null = unknown); and live `nativeBalance` and `trackedTokenBalances` (major stablecoins and wrapped native only; null = could not read)', catalogAnchor: false },
  { path: '/api/v1/tokens', summary: 'token list', catalogAnchor: true },
  { path: '/api/v1/tokens/:contract', summary: 'one token (metadata + indexed holder count) and `lookalike`: the well-known token its name or symbol imitates, or null when it matches none (not a safety verdict)', catalogAnchor: false, routeFile: 'api/v1/tokens/[address]/route.ts' },
  { path: '/api/v1/contracts/:address', summary: 'verified-contract metadata', catalogAnchor: false },
]
