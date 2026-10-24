import { lookalikeNote, type Lookalike } from '@/lib/lookalike-note'

/**
 * The red chip beside a token that reads as a well-known one but is not its contract (lib/lookalike). Server- and
 * client-safe: it takes the flag the server computed and imports only lookalike-note, never the glyph table. The link
 * beside it is a link in a line of text, so give it `font-medium` (see LinkInName).
 */
export function LookalikeBadge({ lookalike, className }: { lookalike: Lookalike; className?: string }) {
  return (
    <span className={className ? `badge badge-bad ${className}` : 'badge badge-bad'} title={lookalikeNote(lookalike)}>
      lookalike<span className="sr-only"> of {lookalike.symbol}</span>
    </span>
  )
}
