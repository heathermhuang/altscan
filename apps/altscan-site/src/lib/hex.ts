// The address and transaction-hash shapes altscan.io's agent surfaces accept (/mcp and the
// in-page WebMCP tools), defined once. Any letter case, no checksum, as the explorers' own
// lib/hex.ts. Pure, so both the Worker and the browser scripts use it.

/** JSON-Schema `pattern` for an address. */
export const ADDRESS_PATTERN = '^0x[0-9a-fA-F]{40}$';
/** JSON-Schema `pattern` for a 32-byte hash. */
export const HASH_PATTERN = '^0x[0-9a-fA-F]{64}$';

const ADDRESS = new RegExp(ADDRESS_PATTERN);
const HASH = new RegExp(HASH_PATTERN);

export const isHexAddress = (v: unknown): v is string => typeof v === 'string' && ADDRESS.test(v);
export const isHexHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
