'use client'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const isDbError =
    error.message?.includes('DATABASE_URL') ||
    error.message?.includes('connect') ||
    error.message?.includes('ECONNREFUSED') ||
    error.message?.includes('connection')

  return (
    <div className="max-w-2xl mx-auto px-4 py-16 text-center">
      <p className="text-4xl mb-4">{isDbError ? '🗄️' : '⚠️'}</p>
      <h2 className="text-xl font-bold mb-3">
        {isDbError ? 'Database not connected' : 'Something went wrong'}
      </h2>
      <p className="text-gray-500 mb-6 text-sm">
        {isDbError
          ? 'Set DATABASE_URL in apps/web/.env.local to a running PostgreSQL instance to see live data.'
          : error.message}
      </p>
      <button
        onClick={reset}
        className="bg-yellow-500 hover:bg-yellow-400 text-black font-semibold px-4 py-2 rounded-lg text-sm"
      >
        Try again
      </button>
    </div>
  )
}
