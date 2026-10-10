import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { formatNumber, safeBigInt } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { chainConfig } from '@/lib/chain'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'
import { blocksIn24h, blocksProduced, minerCounts, type MinerCount } from '@/lib/validator-blocks'
import { validatorDisplays } from '@/lib/validator-display'

export const metadata: Metadata = {
  title: `Validators`,
  description: `${chainConfig.name} validator set — view active validators, voting power, and commission rates on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/validators' },
}

export const revalidate = 300

/** Blocks each miner produced over the last 24h of block numbers; null if the query fails. */
async function fetchBlocks24h(): Promise<Map<string, number> | null> {
  try {
    const rows = await db.execute(sql`
      SELECT miner, count(*)::int AS n FROM blocks
      WHERE number > (SELECT max(number) FROM blocks) - ${blocksIn24h(chainConfig.blockTime)}::bigint
      GROUP BY miner
    `)
    return minerCounts(Array.from(rows) as unknown as MinerCount[])
  } catch (e) {
    swallow('validators/blocks24h', e)
    return null
  }
}

export default async function ValidatorsPage() {
  if (!chainConfig.features.hasValidators) return notFound()

  let validators: typeof schema.validators.$inferSelect[] = []
  try {
    validators = await db.select().from(schema.validators)
      .orderBy(desc(schema.validators.votingPower))
      .limit(100)
  } catch (e) { swallow('validators/query', e) }  // DB not connected
  const blockCounts = validators.length > 0 ? await fetchBlocks24h() : null
  const display = validatorDisplays(validators)
  const blocksCell = (address: string) => {
    const n = blocksProduced(blockCounts, address)
    return n === null ? '—' : formatNumber(n)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-5">
        <p className="k">{'// '}validators</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
          {chainConfig.name} Validators{validators.length > 0 ? ` (${validators.length})` : ''}
        </h1>
      </div>

      {validators.length === 0 ? (
        <div className="rounded-xl border border-hair bg-card p-12 text-center">
          <p className="mb-2 text-lg text-ink2">No validators synced yet</p>
          <p className="text-sm text-mut">
            Validator data will appear here once the indexer has synced {chainConfig.name} validator information.
          </p>
        </div>
      ) : (
      <div className="bg-card rounded-xl border border-hair overflow-hidden">
        <div className="overflow-x-auto">
        <table className="dt">
          <caption className="sr-only">{chainConfig.name} validators ranked by voting power</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Validator</th>
              <th scope="col">Status</th>
              <th scope="col">Voting Power</th>
              <th scope="col">Commission</th>
              <th scope="col">Blocks (24h)</th>
            </tr>
          </thead>
          <tbody>
            {validators.map((v, i) => (
              <tr key={v.address}>
                <td className="text-mut">{i + 1}</td>
                <td>
                  <Link href={`/address/${v.address}`} className="text-acc-ink font-medium hover:underline">
                    {display[i].name}
                  </Link>
                </td>
                <td>
                  <Badge variant={display[i].status.variant}>{display[i].status.label}</Badge>
                </td>
                <td className="whitespace-nowrap">{formatNumber(safeBigInt(v.votingPower) / 10n ** 18n)} {chainConfig.currency}</td>
                <td>{(parseFloat(v.commission ?? '0') * 100).toFixed(1)}%</td>
                <td>{blocksCell(v.address)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      )}
    </div>
  )
}
