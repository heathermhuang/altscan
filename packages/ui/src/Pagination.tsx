import Link from 'next/link'

interface PaginationProps {
  page: number
  pageSize: number
  total: number
  baseUrl: string
}

export function Pagination({ page, pageSize, total, baseUrl }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages <= 1) return null

  const sep = baseUrl.includes('?') ? '&' : '?'

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
      <span className="text-gray-500">
        Page {page} of {totalPages} ({total.toLocaleString()} total)
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={`${baseUrl}${sep}page=${page - 1}`}
            className="px-3 py-1 border rounded hover:bg-gray-50"
          >
            ← Prev
          </Link>
        )}
        {page < totalPages && (
          <Link
            href={`${baseUrl}${sep}page=${page + 1}`}
            className="px-3 py-1 border rounded hover:bg-gray-50"
          >
            Next →
          </Link>
        )}
      </div>
    </div>
  )
}
