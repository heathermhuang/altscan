import { LINK_IN_NAME_NOTE } from '@/lib/link-in-name'

/** The neutral chip beside a token name or symbol that looks like a URL or handle (lib/link-in-name). Server- and client-safe. */
export function LinkInName({ className }: { className?: string }) {
  return <span className={className ? `badge ${className}` : 'badge'} title={LINK_IN_NAME_NOTE}>link in name</span>
}
