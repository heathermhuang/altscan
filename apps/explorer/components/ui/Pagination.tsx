import Link from 'next/link'
import { pageNav } from '@/lib/page-nav'

export function Pagination({ page, total, perPage, baseUrl, hrefFor, rowsOnPage }: {
  page: number
  total: number
  perPage: number
  baseUrl: string
  /** Builds each page's link itself (e.g. a path segment) instead of `${baseUrl}?page=N`. */
  hrefFor?: (page: number) => string
  /** Rows the page rendered, for lists whose `total` is an estimate: a full page then still offers a next link (lib/page-nav.ts). */
  rowsOnPage?: number
}) {
  const nav = pageNav({ page, total, perPage, rowsOnPage })
  if (!nav) return null

  const sep = baseUrl.includes('?') ? '&' : '?'
  const href = hrefFor ?? ((p: number) => `${baseUrl}${sep}page=${p}`)
  return (
    <div className="flex gap-2 items-center font-mono text-[12.5px]">
      {nav.hasPrev && (
        <Link href={href(page - 1)} aria-label="Previous page" className="px-3 py-1 rounded-[9px] border border-hair bg-card text-ink hover:border-hair3 transition-colors">
          ←
        </Link>
      )}
      <span className="text-mut">{nav.label}</span>
      {nav.hasNext && (
        <Link href={href(page + 1)} aria-label="Next page" className="px-3 py-1 rounded-[9px] border border-hair bg-card text-ink hover:border-hair3 transition-colors">
          →
        </Link>
      )}
    </div>
  )
}
