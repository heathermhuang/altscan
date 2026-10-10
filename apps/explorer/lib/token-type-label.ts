/**
 * The label a visitor sees for a token's standard. `tokens.type` is the DB enum
 * 'BEP20' | 'BEP721' | 'BEP1155' on EVERY chain (packages/db/schema.ts), so the enum value is a
 * storage key, never copy: the prefix comes from the chain's configured standard
 * ('ERC-20' on Ethereum, 'BEP-20' on BNB Chain). Pass `chainConfig.tokenStandard`.
 */
export function tokenTypeLabel(type: string, standard: string): string {
  const num = /^BEP(\d+)$/.exec(type)?.[1]
  return num ? `${standard.split('-')[0]}-${num}` : type
}
