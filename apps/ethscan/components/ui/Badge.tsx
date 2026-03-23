type Variant = 'success' | 'fail' | 'pending' | 'default'

const VARIANTS: Record<Variant, string> = {
  success: 'bg-green-100 text-green-700',
  fail:    'bg-red-100 text-red-700',
  pending: 'bg-indigo-100 text-indigo-700',
  default: 'bg-gray-100 text-gray-700',
}

export function Badge({ variant = 'default', children }: { variant?: Variant; children: React.ReactNode }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${VARIANTS[variant]}`}>
      {children}
    </span>
  )
}
