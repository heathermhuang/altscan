type Variant = 'success' | 'fail' | 'pending' | 'default'

const VARIANTS: Record<Variant, string> = {
  success: 'bg-live-t text-live',
  fail:    'bg-warn-t text-warn',
  pending: 'bg-acc-t text-acc-ink',
  default: 'bg-hair2 text-ink2',
}

export function Badge({ variant = 'default', children }: { variant?: Variant; children: React.ReactNode }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-[4px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] ${VARIANTS[variant]}`}>
      {children}
    </span>
  )
}
