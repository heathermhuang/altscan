import Link from 'next/link'

export function Pagination({ page, total, perPage, baseUrl }: {
  page: number
  total: number
  perPage: number
  baseUrl: string
}) {
  const totalPages = Math.ceil(total / perPage)
  if (totalPages <= 1) return null

  return (
    <div className="flex gap-2 items-center text-sm">
      {page > 1 && (
        <Link href={`${baseUrl}?page=${page - 1}`} className="px-3 py-1 rounded border hover:bg-gray-100">
          ←
        </Link>
      )}
      <span className="text-gray-600">Page {page} of {totalPages}</span>
      {page < totalPages && (
        <Link href={`${baseUrl}?page=${page + 1}`} className="px-3 py-1 rounded border hover:bg-gray-100">
          →
        </Link>
      )}
    </div>
  )
}
