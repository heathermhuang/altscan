/**
 * Backfill historical Ethereum blocks.
 * Usage: ETH_BACKFILL_FROM=19000000 ETH_BACKFILL_TO=19001000 pnpm backfill
 */
import { JsonRpcProvider } from 'ethers'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

const RPC_URL = process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com'
const DATABASE_URL = process.env.ETH_DATABASE_URL ?? 'postgresql://localhost:5432/ethscan'
const FROM = parseInt(process.env.ETH_BACKFILL_FROM ?? '0', 10)
const TO = parseInt(process.env.ETH_BACKFILL_TO ?? '0', 10)
const CONCURRENCY = 3

async function main() {
  if (!FROM || !TO || FROM > TO) {
    console.error('Set ETH_BACKFILL_FROM and ETH_BACKFILL_TO')
    process.exit(1)
  }
  console.log(`[eth-backfill] Backfilling blocks ${FROM} → ${TO}`)

  const pgClient = postgres(DATABASE_URL, { max: 5 })
  const db = drizzle(pgClient)
  const provider = new JsonRpcProvider(RPC_URL)

  let completed = 0
  const total = TO - FROM + 1
  const queue: number[] = []
  for (let i = FROM; i <= TO; i++) queue.push(i)

  async function worker() {
    while (queue.length > 0) {
      const num = queue.shift()!
      try {
        const block = await provider.getBlock(num, false)
        if (!block) continue
        await db.execute(sql`
          INSERT INTO blocks (number, hash, parent_hash, timestamp, miner, gas_used, gas_limit, base_fee_per_gas, tx_count, size)
          VALUES (
            ${num},
            ${block.hash ?? ''},
            ${block.parentHash},
            ${new Date(Number(block.timestamp) * 1000).toISOString()},
            ${block.miner.toLowerCase()},
            ${Number(block.gasUsed)},
            ${Number(block.gasLimit)},
            ${(block.baseFeePerGas ?? 0n).toString()},
            ${block.transactions.length},
            ${(block as unknown as { size?: number }).size ?? 0}
          )
          ON CONFLICT (number) DO NOTHING
        `)
        completed++
        if (completed % 100 === 0) {
          console.log(`[eth-backfill] ${completed}/${total} blocks (${Math.round(completed/total*100)}%)`)
        }
      } catch (err) {
        console.warn(`[eth-backfill] Block ${num} failed:`, err instanceof Error ? err.message : err)
        queue.push(num) // retry
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await pgClient.end()
  console.log(`[eth-backfill] Done. ${completed} blocks indexed.`)
}

main().catch(console.error)
