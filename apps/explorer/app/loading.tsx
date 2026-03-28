export default function Loading() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 animate-pulse">
      {/* Header skeleton */}
      <div className="h-8 bg-gray-200 rounded w-64 mb-6" />

      {/* Stats row skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="h-3 bg-gray-200 rounded w-20 mb-2" />
            <div className="h-6 bg-gray-200 rounded w-32" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="bg-gray-50 border-b px-4 py-2">
          <div className="h-4 bg-gray-200 rounded w-48" />
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b flex gap-8">
            <div className="h-4 bg-gray-200 rounded w-32" />
            <div className="h-4 bg-gray-200 rounded w-16" />
            <div className="h-4 bg-gray-200 rounded w-24" />
            <div className="h-4 bg-gray-200 rounded w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}
