// WebMCP (https://webmachinelearning.github.io/webmcp/) tools for the homepage: the lookups each
// explorer registers on its own pages (apps/explorer/components/agent/WebMcpProvider.tsx), plus a
// `chain` argument. Every tool navigates to an explorer page; none calls an API from the browser.
import { products, type Product } from '../data/products';

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown): Promise<{ navigatedTo: string }>;
}

const chainArg = {
  type: 'string',
  enum: products.map((p) => p.id),
  description: products.map((p) => `"${p.id}" = ${p.chain} (${p.domain})`).join(', '),
};
const chainNames = products.map((p) => p.chain).join(' or ');

function hexOf(len: 40 | 64) {
  return new RegExp(`^0x[0-9a-fA-F]{${len}}$`);
}

/** The explorer for args.chain, or a throw an agent can read. */
function explorerFor(args: unknown): { product: Product; a: Record<string, unknown> } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const product = products.find((p) => p.id === a.chain);
  if (!product) throw new Error(`Unknown chain; use one of: ${products.map((p) => p.id).join(', ')}.`);
  return { product, a };
}

function schema(field: string, spec: Record<string, unknown>) {
  return {
    type: 'object',
    required: ['chain', field],
    additionalProperties: false,
    properties: { chain: chainArg, [field]: spec },
  };
}

export function webMcpTools(navigate: (url: string) => void): WebMcpTool[] {
  const go = (url: string) => {
    navigate(url);
    return { navigatedTo: url };
  };
  return [
    {
      name: 'open_transaction',
      description: `Open a ${chainNames} transaction by its 66-character hex hash on that chain's explorer.`,
      inputSchema: schema('hash', { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: 'Transaction hash (0x + 64 hex chars).' }),
      async execute(args) {
        const { product, a } = explorerFor(args);
        if (typeof a.hash !== 'string' || !hexOf(64).test(a.hash)) throw new Error('Invalid transaction hash.');
        return go(`${product.url}/tx/${a.hash}`);
      },
    },
    {
      name: 'open_address',
      description: `Open a ${chainNames} address (EOA or contract) on that chain's explorer.`,
      inputSchema: schema('address', { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'Address (0x + 40 hex chars).' }),
      async execute(args) {
        const { product, a } = explorerFor(args);
        if (typeof a.address !== 'string' || !hexOf(40).test(a.address)) throw new Error('Invalid address.');
        return go(`${product.url}/address/${a.address}`);
      },
    },
    {
      name: 'open_block',
      description: `Open a ${chainNames} block by decimal block number on that chain's explorer.`,
      inputSchema: schema('number', { type: 'integer', minimum: 0, description: 'Block number (non-negative integer).' }),
      async execute(args) {
        const { product, a } = explorerFor(args);
        const n = a.number;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid block number.');
        return go(`${product.url}/blocks/${n}`);
      },
    },
    {
      name: 'search',
      description: `Search a ${chainNames} explorer by hash, address, ENS name, block number, or token symbol.`,
      inputSchema: schema('query', { type: 'string', minLength: 1, maxLength: 128 }),
      async execute(args) {
        const { product, a } = explorerFor(args);
        const q = typeof a.query === 'string' ? a.query.trim() : '';
        if (!q || q.length > 128) throw new Error('Query must be 1-128 characters.');
        return go(`${product.url}/search?q=${encodeURIComponent(q)}`);
      },
    },
  ];
}
