import { Icon } from '@/components/ui/Icon'
import type { RiskSignal } from '@/lib/token-risk'

/**
 * The token page's Risk Signals grid. A signal the explorer could not check (`unknown`: no verified ABI, or the node
 * did not answer) is drawn neutral and read "Not checked", never as a pass: a green check says the explorer looked.
 */
export function RiskSignals({ signals }: { signals: RiskSignal[] }) {
  if (signals.length === 0) return null
  return (
    <div className="mb-6">
      <h2 className="mb-3 flex items-center gap-2 font-semibold tracking-[-0.02em] text-ink">
        <Icon name="shield" className="h-4 w-4 text-mut" />Risk Signals
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {signals.map((s, i) => (
          <div key={i} className={`flex items-start gap-2 rounded-xl border border-hair border-l-[3px] px-3 py-2 text-sm
            ${s.severity === 'danger' ? 'border-l-warn bg-warn-t' : s.severity === 'warn' ? 'border-l-warn bg-card' : s.unknown ? 'border-l-hair3 bg-card' : 'border-l-acc bg-card'}`}>
            <Icon
              name={s.unknown ? 'info' : s.ok ? 'check' : s.severity === 'danger' ? 'danger' : 'warn'}
              className={`mt-0.5 h-4 w-4 ${s.unknown ? 'text-mut' : s.ok ? 'text-live' : 'text-warn'}`}
            />
            <div>
              <p className="font-medium text-ink">
                <span className="sr-only">{s.unknown ? 'Not checked: ' : s.ok ? 'Pass: ' : s.severity === 'danger' ? 'Danger: ' : 'Warning: '}</span>
                {s.label}
              </p>
              <p className="text-xs text-ink2">{s.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
