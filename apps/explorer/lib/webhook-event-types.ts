/**
 * Which webhook event types a registration may ask for, and which of them are actually stored.
 *
 * The indexer delivers `tx` events and nothing else (apps/indexer/src/webhook-notifier.ts skips any
 * webhook whose eventTypes lacks 'tx'). Registration used to accept `token_transfer` and `new_block` as
 * if they worked, so a webhook asking only for them was created, counted against the owner's cap, and
 * never fired.
 *
 * A list that includes 'tx' is accepted whatever else it names: older clients send ['tx',
 * 'token_transfer'], and rejecting that would break them for no gain. Only 'tx' is stored; everything
 * else is reported back in `ignoredEventTypes` so the caller sees what it is not getting.
 */
export const DELIVERED_EVENT_TYPES: readonly string[] = ['tx']

export type EventTypeResolution =
  | { ok: true; eventTypes: string[]; ignoredEventTypes: string[] }
  | { ok: false; error: string }

export function resolveEventTypes(requested: unknown): EventTypeResolution {
  const list = requested === undefined || requested === null ? ['tx'] : requested
  if (!Array.isArray(list)) return { ok: false, error: 'eventTypes must be an array of strings' }

  const asked = [...new Set(list.map(e => String(e)))]
  const eventTypes = asked.filter(e => DELIVERED_EVENT_TYPES.includes(e))
  if (eventTypes.length === 0) {
    return { ok: false, error: "eventTypes must include 'tx': only 'tx' events are delivered" }
  }
  return { ok: true, eventTypes, ignoredEventTypes: asked.filter(e => !DELIVERED_EVENT_TYPES.includes(e)) }
}
