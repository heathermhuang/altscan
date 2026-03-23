import Link from 'next/link'

export function Pagination({
  page,
  total,
  perPage,
  baseUrl,
}: {
  page: number
  total: number
  perPage: number
  baseUrl: string
}) {
  const totalPages = Math.ceil(total / perPage)
  if (totalPages <= 1) return null

  const sep = baseUrl.includes('?') ? '&' : '?'

  return (
    <div className="flex items-center gap-2 text-sm">
      {page > 1 && (
        <Link
          href={`${baseUrl}${sep}page=${page - 1}`}
          className="px-3 py-1.5 rounded border border-gray-200 hover:border-indigo-400 text-gray-600 hover:text-indigo-600 transition-colors"
        >
          ← Prev
        </Link>
      )}
      <span className="px-3 py-1.5 text-gray-500">
        Page {page} of {totalPages.toLocaleString()}
      </span>
      {page < totalPages && (
        <Link
          href={`${baseUrl}${sep}page=${page + 1}`}
          className="px-3 py-1.5 rounded border border-gray-200 hover:border-indigo-400 text-gray-600 hover:text-indigo-600 transition-colors"
        >
          Next →
        </Link>
      )}
    </div>
  )
}
