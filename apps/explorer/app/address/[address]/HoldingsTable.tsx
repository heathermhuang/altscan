import Link from 'next/link'
import { sanitizeSymbolOr, tokenLabel } from '@/lib/format'
import { usdText, type HoldingRow } from '@/lib/holdings'

// Kicker-style column header, matching components/transactions/TxTable.
const TH = 'text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut'

/** One line above the table: where each kind of number comes from. */
export function HoldingsBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-hair border-l-[3px] border-l-acc rounded-xl px-4 py-3 mb-4 text-sm text-ink2 flex items-center gap-2">
      <svg className="w-4 h-4 shrink-0 text-acc-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="2"/>
        <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
      </svg>
      <span>{children}</span>
    </div>
  )
}

/** What a priced row's USD value rests on, for the cell's tooltip. */
const basisTitle = (r: HoldingRow, nativeSymbol: string) =>
  r.basis === 'stablecoin' ? 'Stablecoin, valued at $1 per token'
    : r.basis === 'native' ? `Valued at the live ${nativeSymbol} price`
      : r.basis === 'provider' ? 'Price from Moralis'
        : undefined

/** The holdings table, sorted by the caller. Shared by the server tab and the lazy (client) tab. */
export function HoldingsTable({ rows, caption, nativeSymbol }: { rows: readonly HoldingRow[]; caption: string; nativeSymbol: string }) {
  return (
    <div className="bg-card rounded-xl border border-hair overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-canvas border-b border-hair">
          <tr>
            <th scope="col" className={TH}>Token</th>
            <th scope="col" className={TH}>Symbol</th>
            <th scope="col" className={TH}>Balance</th>
            <th scope="col" className={TH}>USD Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {rows.map((r) => (
            <tr key={r.tokenAddress} className="hover:bg-canvas transition-colors">
              <td className="px-3 sm:px-4 py-2">
                <Link href={`/token/${r.tokenAddress}`} className="text-acc-ink hover:underline font-medium">
                  {tokenLabel(r.symbol, r.name, r.tokenAddress)}
                </Link>
              </td>
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-ink2">{sanitizeSymbolOr(r.symbol, '—')}</td>
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">{r.amount}</td>
              <td
                className={`px-3 sm:px-4 py-2 font-mono text-[13px]${r.usd === null ? ' text-mut' : ''}`}
                title={basisTitle(r, nativeSymbol)}
              >
                {usdText(r)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
