// The skeleton a detail route shows first while its page streams in: a detail page's first screen
// (kicker + h1 + id line, a 4-cell fact strip, a table), about 1000px tall at the real row height.
// That height keeps the footer below the fold on common viewports, so the real page replaces it
// without moving anything visible (a shorter skeleton left the footer on screen and it jumped).
// React ships this tree twice per page (Suspense fallback and RSC payload), so it is 8 elements
// and the bars and row lines are drawn by the .skel-* gradients in globals.css, not by markup.
// Only tx/address/block/token get a loading.tsx (each re-exports this): they can wait on RPC
// fallbacks, so they keep feedback. A root one wrapped the list pages too, where the shell paints
// before the content's $RC script and React 19.2's reveal throttle held it to $RT + 300ms (late
// LCP).
export function DetailSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 animate-pulse">
      <div className="skel-head" />
      <div className="ledger [--cols:4] skel-f">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="skel-table" />
    </div>
  )
}
