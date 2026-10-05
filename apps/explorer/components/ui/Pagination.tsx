import Link from 'next/link'

export function Pagination({ page, total, perPage, baseUrl }: {
  page: number
  total: number
  perPage: number
  baseUrl: string
}) {
  const totalPages = Math.ceil(total / perPage)
  if (totalPages <= 1) return null

  const sep = baseUrl.includes('?') ? '&' : '?'
  return (
    <div className="flex gap-2 items-center font-mono text-[12.5px]">
      {page > 1 && (
        <Link href={`${baseUrl}${sep}page=${page - 1}`} aria-label="Previous page" className="px-3 py-1 rounded-[9px] border border-hair bg-card text-ink hover:border-hair3 transition-colors">
          ←
        </Link>
      )}
      <span className="text-mut">Page {page} of {totalPages}</span>
      {page < totalPages && (
        <Link href={`${baseUrl}${sep}page=${page + 1}`} aria-label="Next page" className="px-3 py-1 rounded-[9px] border border-hair bg-card text-ink hover:border-hair3 transition-colors">
          →
        </Link>
      )}
    </div>
  )
}
