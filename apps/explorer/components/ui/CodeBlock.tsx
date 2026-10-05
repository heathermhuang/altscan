/**
 * A scrollable code sample. `tabIndex` makes the scroll region keyboard-reachable
 * (axe: scrollable-region-focusable) now that it can overflow on phones, and `role` + `label`
 * give that focus stop a name.
 */
export function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={label}
      className="overflow-auto rounded-lg bg-hair2 p-4 font-mono text-xs leading-relaxed text-ink"
    >
      {children}
    </pre>
  )
}
