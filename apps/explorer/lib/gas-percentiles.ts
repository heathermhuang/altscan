import { sql, type SQL } from 'drizzle-orm'
import type { Db } from '@altscan/db'
import { db } from '@/lib/db'
import { GAS_TIER_BLOCKS, gasTiersFrom, type GasTiers } from '@/lib/gas-tiers'
import { createPageCache } from '@/lib/page-cache'
import { withTimeout } from '@/lib/with-timeout'

/**
 * The /gas tiers: one bounded query over the transactions of the newest GAS_TIER_BLOCKS blocks.
 *
 * `recent` is a primary-key walk of `blocks` stopped at 20 rows, and each of them reaches its transactions
 * through tx_block_idx, so the cost is the window's own rows (a few hundred to a few thousand), never the table.
 *
 * What is measured, per transaction: gas_price - the block's base fee, floored at 0 (the tx page's rule for
 * a malformed row). On an EIP-1559 chain gas_price is the EFFECTIVE price, so that is the priority fee (tip);
 * BNB's blocks carry a base fee of 0, so it is the gas price itself. Zero-priced transactions (BNB's system
 * transactions) are not a fee anyone chose and are left out. Where the newest block has a base fee (the tip
 * regime), a block with NO base fee has no knowable tip, and COALESCE(.., 0) would read its whole price as tip:
 * those blocks are left out of the sample (where there is no base fee the column is not used, so none are).
 *
 * percentile_disc, not _cont: it returns a value some transaction actually paid, so no tier is an interpolation.
 * The array form sorts once and returns numeric[], read here as text so no precision is lost on the way to JS.
 */
export function gasTiersQuery(): SQL {
  return sql`
    WITH recent AS (
      SELECT number, base_fee_per_gas FROM blocks ORDER BY number DESC LIMIT ${sql.raw(String(GAS_TIER_BLOCKS))}
    ), tip_regime AS (
      SELECT COALESCE((SELECT base_fee_per_gas FROM recent ORDER BY number DESC LIMIT 1), 0) > 0 AS tips
    )
    SELECT
      (SELECT count(*) FROM recent)::int AS blocks,
      (SELECT base_fee_per_gas FROM recent ORDER BY number DESC LIMIT 1)::text AS base_fee,
      count(t.hash)::int AS txs,
      (percentile_disc(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (
        ORDER BY GREATEST(t.gas_price - COALESCE(r.base_fee_per_gas, 0), 0)
      ))::text[] AS tiers
    FROM recent r
    JOIN transactions t ON t.block_number = r.number AND t.gas_price > 0
    WHERE r.base_fee_per_gas IS NOT NULL OR NOT (SELECT tips FROM tip_regime)`
}

/** The tiers, or null when the sample is too thin (lib/gas-tiers gasTiersFrom). THROWS on a failed query, so the cache below never stores a failure. */
export async function queryGasTiers(d: Pick<Db, 'execute'>): Promise<GasTiers | null> {
  const [row] = Array.from(await d.execute(gasTiersQuery())) as Record<string, unknown>[]
  return gasTiersFrom(row && {
    blocks: Number(row.blocks),
    txs: Number(row.txs),
    baseFee: row.base_fee == null ? null : String(row.base_fee),
    tiers: Array.isArray(row.tiers) ? row.tiers.map(v => (v == null ? null : String(v))) : null,
  })
}

/** Literal for the same reason as the other pages' (Next cannot resolve an imported `revalidate`); pinned by revalidate-parity.test.ts. */
export const GAS_REVALIDATE_SECONDS = 45

// Strings and null only (no BigInt in a cached value). Rename 'gas-tiers-v1' whenever the value's shape changes.
export const fetchGasTiers = createPageCache('gas-tiers-v1', GAS_REVALIDATE_SECONDS, () => withTimeout(queryGasTiers(db)))
