/**
 * A scrollable code sample. `tabIndex` makes the scroll region keyboard-reachable
 * (axe: scrollable-region-focusable) now that it can overflow on phones, and `role` + `label`
 * give that focus stop a name. The box is the wrapper's, so the text fades at the right edge
 * (`fade-r`) where a line runs on, and the box does not: `pr-6` is as wide as the fade, so a block
 * that fits, or is scrolled to its end, has nothing in it.
 */
export function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="rounded-lg bg-hair2">
      <pre
        tabIndex={0}
        role="region"
        aria-label={label}
        className="fade-r overflow-auto rounded-lg py-4 pl-4 pr-6 font-mono text-xs leading-relaxed text-ink"
      >
        {children}
      </pre>
    </div>
  )
}
