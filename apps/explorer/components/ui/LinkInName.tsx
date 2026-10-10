import { LINK_IN_NAME_NOTE } from '@/lib/link-in-name'

/**
 * The neutral chip beside a token name or symbol that looks like a URL or handle (lib/link-in-name). Server- and client-safe.
 * A link beside it is a link in a line of text, so colour alone must not be what tells it from the text (axe link-in-text-block,
 * which fails in dark mode): give that link `font-medium`, as the /token list and the holdings table do.
 */
export function LinkInName({ className }: { className?: string }) {
  return <span className={className ? `badge ${className}` : 'badge'} title={LINK_IN_NAME_NOTE}>link in name</span>
}
