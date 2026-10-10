import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatNativeToken, timeAgo } from '@/lib/format'
import { shortHash } from '@/lib/address-display'

/**
 * `detailClass` for the provider's summary cell: sans, muted, one truncated line. The width cap is
 * from sm up only, because on a phone the cell is stretched across the card by `.dt-ad` and a plain
 * `max-w-xs` (320px) would cap it on 376-639px phones.
 */
export const PROVIDER_DETAIL_CLASS = 'font-sans text-ink2 sm:max-w-xs truncate'

export type TxnRow = {
  hash: string
  timestamp: Date | string | number
  /** The third cell: who the other side is (the local index) or what the transaction did (the provider's summary). */
  detail: ReactNode
  /** Wei, as a decimal string or a bigint. */
  value: bigint | string
  /** A possible-spam row, drawn faded. */
  faded?: boolean
}

/**
 * An address's transactions, for both of its sources (the local index and the history provider): one
 * table, whose four cells (hash, age, detail, value) `.dt-ad` in app/globals.css lays out as a
 * two-line card under 640px, so a phone shows all four without scrolling. Keep that cell order, and
 * keep utility classes off the cells (they would beat the phone layout): `detailClass` is for the
 * properties it does not touch (the provider's summary is sans and truncated).
 *
 * Takes the currency as a prop because the client component using it reads its chain from a different
 * module than the server page does.
 */
export function TxnsTable({ caption, rows, currency, detailHeading, detailClass, unitInHeading = false }: {
  caption: string
  rows: TxnRow[]
  currency: string
  detailHeading: string
  detailClass?: string
  /** The heading says "Value (BNB)", so the desktop cell is the bare number; the unit then shows on phones only (their headings are hidden). */
  unitInHeading?: boolean
}) {
  return (
    // leading-5: the 20px line height these tables always had (from `text-sm`), which `.dt` alone would
    // drop to the page's, shrinking every desktop row by about a pixel.
    <table className="dt dt-a dt-ad leading-5">
      <caption className="sr-only">{caption}</caption>
      <thead className="max-sm:sr-only">
        <tr>
          <th scope="col">Tx Hash</th>
          <th scope="col">Age</th>
          <th scope="col">{detailHeading}</th>
          <th scope="col">{unitInHeading ? `Value (${currency})` : 'Value'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.hash} className={r.faded ? 'opacity-50' : undefined}>
            <td>
              <Link href={`/tx/${r.hash}`}>{shortHash(r.hash)}</Link>
            </td>
            <td className="text-mut">{timeAgo(new Date(r.timestamp))}</td>
            <td className={detailClass}>{r.detail}</td>
            <td>
              {formatNativeToken(r.value)}
              {unitInHeading ? <span className="sm:hidden"> {currency}</span> : <> {currency}</>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
