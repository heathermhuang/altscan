// The skeleton every route shows first while its page streams in. It mirrors a detail page's first
// screen (kicker + h1 + id line, a fact strip, a table) at the real row height (38px from 640px,
// 56px below it, where addresses wrap) and runs ~1000px tall, so the footer starts below the fold
// on common viewports and the real page replaces it without moving anything visible. A shorter
// skeleton left the footer on screen, and it jumped when the page arrived.
const ROWS = 18

export default function Loading() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 animate-pulse">
      {/* Header skeleton: kicker, h1, id line */}
      <div className="mb-5">
        <div className="h-[18px] w-24 rounded bg-hair2 bg-clip-content py-[3px]" />
        <div className="mt-2 h-[clamp(27px,3.57vw,42px)] w-64 max-w-full rounded bg-hair2" />
        <div className="mt-2 h-5 w-96 max-w-full rounded bg-hair2" />
      </div>

      {/* Fact strip skeleton */}
      <div className="ledger [--cols:4] mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-3 w-16 rounded bg-hair2" />
            <div className="mt-3 h-5 w-28 rounded bg-hair2" />
            <div className="mt-2 h-3 w-20 rounded bg-hair2" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="overflow-hidden rounded-xl border border-hair bg-card">
        <div className="flex h-[34px] items-center border-b border-hair bg-canvas px-3 sm:px-4">
          <div className="h-3 w-48 rounded bg-hair2" />
        </div>
        {Array.from({ length: ROWS }).map((_, i) => (
          <div key={i} className="flex h-14 items-center gap-4 border-b border-hair px-3 last:border-b-0 sm:h-[38px] sm:px-4">
            <div className="h-3 w-1/4 rounded bg-hair2" />
            <div className="h-3 w-1/6 rounded bg-hair2" />
            <div className="h-3 w-1/3 rounded bg-hair2" />
          </div>
        ))}
      </div>
    </div>
  )
}
