import type { KeyboardEvent } from 'react'

/**
 * Left / right arrow keys move focus to the neighbouring tile of a tape: the tape is one tab stop and the
 * arrows walk it (roving tabindex). `onKeyDown` goes on the list; a tile is `<li><a/></li>`, so the
 * neighbour is the next `li`'s link. The oldest and newest tile have no neighbour, so focus stops there,
 * and a tile with no link (the "others" remainder of a holders strip) is stepped over to nothing.
 * Shared by the home tape (components/home/BlockTape.tsx) and every TileStrip.
 */
export function onArrowKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
  if (!dir) return
  e.preventDefault()
  const li = (e.target as HTMLElement).closest('li')
  const a = (dir < 0 ? li?.previousElementSibling : li?.nextElementSibling)?.querySelector('a')
  a?.focus()
}
