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
      <h1 className="mb-3 text-xl font-bold tracking-[-0.02em] text-ink">
        {isDbError ? 'Database not connected' : 'Something went wrong'}
      </h1>
      <p className="mb-6 break-words text-sm text-ink2">
        {isDbError
          ? 'Set DATABASE_URL in apps/explorer/.env.local to a running PostgreSQL instance to see live data.'
          : error.message}
      </p>
      <button
        onClick={reset}
        className="rounded-[9px] bg-ink px-4 py-2 text-sm font-semibold text-card transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </div>
  )
}
