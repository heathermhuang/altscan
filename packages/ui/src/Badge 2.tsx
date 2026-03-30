export function Badge({
  children,
  variant = 'default',
}: {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'fail' | 'warn'
}) {
  const cls = {
    default: 'bg-gray-100 text-gray-700',
    success: 'bg-green-100 text-green-700',
    fail: 'bg-red-100 text-red-700',
    warn: 'bg-yellow-100 text-yellow-800',
  }[variant]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {children}
    </span>
  )
}
