import type { CSSProperties } from 'react'
import { formatSpan, ledgerWeight, type LedgerRow } from '@/lib/ledger'

const legend = (currency: string) =>
  `width = time since the previous transaction · above the line = received, below = sent · solid = ${currency}, outlined = tokens or calls · newest on the right`

/**
 * A page of an address's transactions as a ledger: oldest left, newest right; width = time since
 * the previous one (the first has none: it counts as 1 s); above the axis = received, below = sent; solid = native value, outlined =
 * tokens or calls. Value is deliberately not drawn (token rows carry value 0 and there are no
 * prices to compare them). Nothing for fewer than 2 rows.
 */
export function AddressLedger({ rows, currency }: { rows: LedgerRow[]; currency: string }) {
  if (rows.length < 2) return null
  const nin = rows.filter(r => r.dir === 'in').length
  const nout = rows.length - nin
  const gap = rows[rows.length - 1].t - rows[0].t
  const span = gap < 1 ? 'in the same second' : `over ${formatSpan(gap)}`
  return (
    <figure className="ldg">
      <div className="tp-head ldg-head">
        <span className="flex items-center min-w-0">
          <span className="tp-dot" aria-hidden="true" />
          <span className="text-ink truncate">These {rows.length} transactions<span className="hidden md:inline text-mut">, as a ledger</span></span>
        </span>
        <span className="whitespace-nowrap">▲ {nin} received · ▼ {nout} sent<span className="tp-rate"> · {span}</span></span>
      </div>
      <div className="ldg-row" role="img" aria-label={`${rows.length} transactions ${span}: ${nin} received, ${nout} sent`}>
        {rows.map((r, k) => (
          <i
            key={k}
            className={`${r.dir}${r.native ? '' : ' o'}${r.spam ? ' s' : ''}`}
            style={{ '--w': ledgerWeight(k ? r.t - rows[k - 1].t : 1) } as CSSProperties}
          />
        ))}
      </div>
      <figcaption className="tp-leg">{legend(currency)}</figcaption>
    </figure>
  )
}

/** The ledger's frame while TxnsLazy loads: same box, no tiles, so the swap does not move the table. */
export function AddressLedgerShell({ currency }: { currency: string }) {
  return (
    <figure className="ldg animate-pulse" aria-hidden="true">
      <div className="tp-head ldg-head"><span>&nbsp;</span><span>&nbsp;</span></div>
      <div className="ldg-row" />
      <figcaption className="tp-leg">{legend(currency)}</figcaption>
    </figure>
  )
}
