type Variant = 'success' | 'fail' | 'pending' | 'default'

// Literal class names, here, so Tailwind's content scan keeps their rules (app/globals.css).
const VARIANTS: Record<Variant, string> = {
  success: 'badge badge-ok',
  fail:    'badge badge-bad',
  pending: 'badge badge-acc',
  default: 'badge',
}

export function Badge({ variant = 'default', children }: { variant?: Variant; children: React.ReactNode }) {
  return (
    <span className={VARIANTS[variant]}>
      {children}
    </span>
  )
}
