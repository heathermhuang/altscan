/**
 * A scrollable code sample. `tabIndex` makes the scroll region keyboard-reachable
 * (axe: scrollable-region-focusable) now that it can overflow on phones.
 */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      tabIndex={0}
      className="overflow-auto rounded-lg bg-hair2 p-4 font-mono text-xs leading-relaxed text-ink"
    >
      {children}
    </pre>
  )
}
