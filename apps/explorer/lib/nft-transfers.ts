import { sql } from 'drizzle-orm'

/** NFT transfers read per side, newest first, before the BEP-721 filter. */
export const NFT_SIDE_SCAN = 1_000

/**
 * The address page's NFTs tab: the address's newest BEP-721 transfers, at most `limit`.
 *
 * NOT `(to_address = a OR from_address = a) AND token_id IS NOT NULL ORDER BY block_number DESC`. No index served
 * that filter in that order, so for a busy wallet with few or no NFTs the planner walked the block_number order (or
 * read every transfer of the address) filtering for NFT rows: the cost was the wallet's whole transfer history.
 *
 * Instead one read per side of tt_nft_to_blk_idx / tt_nft_from_blk_idx, partial indexes that hold only the rows with
 * a token_id (BEP-721/1155 transfers), so a wallet with no NFTs is one empty index probe, and a read costs the
 * address's NFT rows on that side at most: the planner walks the index newest first and stops at NFT_SIDE_SCAN, or,
 * for a side with few enough, reads them all and sorts. BEP-1155 rows pass the index and are dropped by the type
 * join after it, so each side keeps its newest NFT_SIDE_SCAN only, and the answer is partial for a wallet whose
 * newest NFT_SIDE_SCAN NFT transfers on a side are all 1155s: BEP-721 transfers older than those are not shown.
 * `token_id IS NOT NULL` must stay literal for the planner to prove the indexes apply. As in selectByAddress, the
 * `to` side drops rows the `from` side has (a transfer to itself) after its LIMIT, not in its WHERE, so a wallet that
 * sends to itself cannot make that walk read its whole history.
 *
 * The type check is a primary-key lookup per row (LATERAL … LIMIT 1, which cannot be flattened), never a join over
 * `tokens`: a hash join would read the whole table, ~1.9M rows on BNB, even for a wallet with no NFTs.
 */
export function nftTransfersQuery(addr: string, limit: number) {
  return sql`
    WITH from_side AS (
      SELECT * FROM token_transfers
      WHERE from_address = ${addr} AND token_id IS NOT NULL
      ORDER BY block_number DESC
      LIMIT ${NFT_SIDE_SCAN}
    ), to_side AS (
      SELECT * FROM token_transfers
      WHERE to_address = ${addr} AND token_id IS NOT NULL
      ORDER BY block_number DESC
      LIMIT ${NFT_SIDE_SCAN}
    )
    SELECT
      tt.tx_hash AS "txHash",
      tt.token_address AS "tokenAddress",
      tt.token_id::text AS "tokenId",
      tt.from_address AS "fromAddress",
      tt.to_address AS "toAddress",
      tt.block_number AS "blockNumber",
      t.name,
      t.symbol
    FROM (
      SELECT * FROM from_side
      UNION ALL
      SELECT * FROM to_side WHERE from_address <> ${addr}
    ) tt
    CROSS JOIN LATERAL (
      SELECT name, symbol FROM tokens WHERE address = tt.token_address AND type = 'BEP721' LIMIT 1
    ) t
    ORDER BY tt.block_number DESC
    LIMIT ${limit}
  `
}
