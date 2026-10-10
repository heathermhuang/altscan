'use client'

import { useEffect, useState } from 'react'
import { formatHolders } from '@/lib/format'
import { HOLDER_LABELS, holdersPhrase, type HolderSource } from '@/lib/holder-labels'
import type { HoldersResult } from '@/lib/holders'
import { AddressLink } from '@/components/ui/AddressLink'
import { Icon } from '@/components/ui/Icon'

/**
 * Client-side holders enhancement. SSR renders the labeled local net-flow estimate (0 Moralis
 * CU, safe for crawlers / no-JS scrapers hitting the origin direct); on mount the browser fetches
 * accurate Moralis holders via /api/internal/token/<addr>/holders and swaps them in. Bots never
 * run this effect, so they never spend Moralis CU — the same model as the address tabs.
 *
 * The table and the stat-card count share ONE in-flight fetch per address (the dedupe map below),
 * so a single render makes a single XHR. (Server-side the Moralis calls are KV-cached 2h, so it's
 * also CU-safe across visitors — the client dedupe just avoids a redundant round-trip.)
 */
const inflight = new Map<string, Promise<HoldersResult | null>>()
function loadHolders(address: string): Promise<HoldersResult | null> {
  let p = inflight.get(address)
  if (!p) {
    p = fetch(`/api/internal/token/${address}/holders`)
      .then((r) => (r.ok ? (r.json() as Promise<HoldersResult>) : null))
      .catch(() => null)
    inflight.set(address, p)
  }
  return p
}

/**
 * The Holders fact, as a view: the number with the label of the source it came from. The two sources
 * disagree by orders of magnitude (see lib/holder-labels.ts), so the label is part of the fact.
 * Markup matches the page's `Fact`.
 */
export function HoldersFactView({ count, source }: { count: number | null; source: HolderSource }) {
  return (
    <div>
      <dt className="k">{HOLDER_LABELS[source].heading}</dt>
      <dd className="mt-1 break-words font-mono text-[15px] text-ink" title={HOLDER_LABELS[source].title}>{formatHolders(count)}</dd>
    </div>
  )
}

/**
 * The Holders stat-card. Shows the indexed count (the server render) until the live Moralis total
 * arrives, then that total under its own label, consistent with the "via Moralis" Top Holders header.
 */
export function HoldersFact({ address, fallback }: { address: string; fallback: number }) {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    loadHolders(address).then((d) => {
      if (alive && d && d.source === 'moralis' && d.holderCount != null) setCount(d.holderCount)
    })
    return () => {
      alive = false
    }
  }, [address])
  return count === null
    ? <HoldersFactView count={fallback} source="indexed" />
    : <HoldersFactView count={count} source="provider" />
}

/** The two notes are about the same length on purpose: the slot is sized by the longer one. */
const NOTES = {
  local: "Estimated from the net flow of this token's most recent 10,000 transfers, not full on-chain balances — large steady holders (e.g. exchanges) may be missing.",
  moralis: "Real on-chain balances, ranked highest first, as reported by Moralis. Results are cached and refresh periodically, so the very latest transfers may not show yet.",
}

export function HoldersLazy({
  address,
  symbol,
  decimals,
  totalSupply,
  initial,
}: {
  address: string
  symbol: string
  decimals: number
  totalSupply: string | null
  initial: HoldersResult
}) {
  const [data, setData] = useState<HoldersResult>(initial)
  useEffect(() => {
    let alive = true
    loadHolders(address).then((d) => {
      if (alive && d && d.holders.length > 0) setData(d)
    })
    return () => {
      alive = false
    }
  }, [address])

  // Nothing to show yet (empty local estimate + Moralis not loaded / also empty).
  if (data.holders.length === 0) return null

  const totalSupplyBig = (() => {
    try {
      return BigInt(totalSupply ?? '0')
    } catch {
      return 0n
    }
  })()

  return (
    <div className="bg-card rounded-xl border border-hair mb-6 overflow-hidden">
      <div className="px-4 py-3 border-b border-hair flex items-center justify-between gap-2">
        <h2 className="font-semibold tracking-[-0.02em] text-ink">Top Holders</h2>
        {/* The Moralis total sits where the source label used to: the same single line as "Estimated from
            recent transfers", so the estimate -> live swap does not re-wrap the header on a phone. */}
        <span className="text-[11px] text-mut">
          {data.source === 'moralis'
            ? data.holderCount != null ? holdersPhrase(data.holderCount, 'provider') : 'via Moralis'
            : 'Estimated from recent transfers'}
        </span>
      </div>
      {/* The note slot renders in BOTH states with the same box, and both notes sit in one grid
          cell (the one not shown is `invisible`), so the slot is as tall as the longer note at
          every width: the estimate -> live swap changes the note, never the rows' position. */}
      <div
        className={`flex items-start gap-2 px-4 py-2 text-ink2 text-xs border-b border-hair border-l-[3px] ${
          data.source === 'local' ? 'bg-warn-t border-l-warn' : 'bg-canvas border-l-hair3'
        }`}
      >
        <Icon
          name={data.source === 'local' ? 'warn' : 'info'}
          className={`mt-px h-3.5 w-3.5 ${data.source === 'local' ? 'text-warn' : 'text-mut'}`}
        />
        <span className="grid">
          {(['local', 'moralis'] as const).map((source) => (
            <span key={source} className={`[grid-area:1/1]${source === data.source ? '' : ' invisible'}`}>
              {NOTES[source]}
            </span>
          ))}
        </span>
      </div>
      <div className="overflow-x-auto">
      <table className="dt dt-2l">
        <caption className="sr-only">Top holders of {symbol}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Address</th>
            <th scope="col">
              {data.source === 'moralis' ? 'Balance' : 'Approx. Balance'}
            </th>
            <th scope="col">% of Supply</th>
          </tr>
        </thead>
        <tbody>
          {data.holders.map((holder, i) => {
            const holderAmount = (() => {
              try {
                const divisor = 10n ** BigInt(decimals)
                const whole = BigInt(holder.balance) / divisor
                return whole.toLocaleString()
              } catch {
                return holder.balance.slice(0, 12)
              }
            })()
            const pct = (() => {
              try {
                if (totalSupplyBig === 0n) return '—'
                const bal = BigInt(holder.balance)
                // Integer math, scaled by 10000 for 2 decimal places.
                const scaled = (bal * 10000n) / totalSupplyBig
                return `${(Number(scaled) / 100).toFixed(2)}%`
              } catch {
                return '—'
              }
            })()
            return (
              <tr key={holder.addr}>
                <td className="text-mut">{i + 1}</td>
                <td>
                  {/* Full address from sm up; the short form below it so Balance and % stay on screen on phones. */}
                  <span className="sm:hidden"><AddressLink address={holder.addr} /></span>
                  <span className="hidden sm:inline"><AddressLink address={holder.addr} short={false} /></span>
                </td>
                <td>
                  {holderAmount} {symbol}
                </td>
                <td className="text-mut">{pct}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}
