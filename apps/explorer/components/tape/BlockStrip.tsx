import type { CSSProperties } from 'react'
import { formatShare, ordinal } from '@/lib/format'
import { stripFills, stripWeight, type StripTx } from '@/lib/tape'

const fmt = (n: number) => n.toLocaleString('en-US')
const LEGEND = 'width = gas used · fill = gas price paid · ▨ failed · in block order'

/**
 * The transactions of one block as tiles: width = gas used, fill = gas price paid (log, block
 * min→max), hatched = failed, in tx_index order. `current` (a tx_index) is ringed and labelled.
 * Widths are pure CSS (app/globals.css, "Block strip"): flex-grow = gas in thousands, no gaps, so
 * the strip is exactly the content width at every viewport and never scrolls.
 */
export function BlockStrip({ txs, blockNumber, gasLimit, chainName, current, className }: {
  txs: StripTx[]
  blockNumber: number
  gasLimit: number
  chainName: string
  current?: number
  className?: string
}) {
  const fills = stripFills(txs.map(t => t.price))
  const used = txs.reduce((s, t) => s + t.gas, 0)
  const failed = txs.filter(t => !t.ok).length
  const pct = gasLimit > 0 ? Math.round((used / gasLimit) * 100) : null
  const curPos = current === undefined ? -1 : txs.findIndex(t => t.i === current)
  const cur = curPos >= 0 ? txs[curPos] : undefined
  const share = cur && used > 0 ? formatShare((cur.gas / used) * 100) : null
  // The chip anchors toward the middle by where the tile SITS (gas-weighted, as the flex lays it
  // out), not by its tx_index: a 2nd-of-60 tx behind a huge one is at the far right, and a
  // left-anchored chip there would run off the viewport.
  const weights = txs.map(t => stripWeight(t.gas))
  const weightSum = weights.reduce((s, w) => s + w, 0)
  const centre = curPos >= 0 ? (weights.slice(0, curPos).reduce((s, w) => s + w, 0) + weights[curPos] / 2) / weightSum : 0
  const label = `${chainName} block ${fmt(blockNumber)}: ${txs.length} transactions, ${failed} failed`
    + (cur ? `; this one is the ${ordinal(curPos + 1)}${share !== null ? ` and used ${share}% of the block's gas` : ''}` : '')

  return (
    <div className={`bt-box${className ? ` ${className}` : ''}`}>
      <div className="bt-head">
        <span className="flex items-center min-w-0">
          <span className="bt-dot" aria-hidden="true" />
          <span className="text-ink truncate">
            Block #{fmt(blockNumber)}<span className="hidden sm:inline text-mut">, transaction by transaction</span>
          </span>
        </span>
        <span className="bt-stats">
          <span>{txs.length} txns · {failed} failed</span>
          {pct !== null && <span className="bt-rate">gas {pct}% of limit</span>}
        </span>
      </div>
      <div className={`bs-track max-w-7xl mx-auto px-4${cur ? ' bs-has-cur' : ''}`}>
        <div className="bs-row" role="img" aria-label={label}>
          {txs.map((t, k) => {
            const cls = [k === curPos && 'c', !t.ok && 'x'].filter(Boolean).join(' ')
            return (
              <i key={t.i} className={cls || undefined} style={{ '--w': weights[k], '--f': `${fills[k]}%` } as CSSProperties}>
                {k === curPos && (
                  <span className={`bs-chip${centre < 0.5 ? ' l' : ''}`}>this tx · {fmt(t.gas)} gas</span>
                )}
              </i>
            )
          })}
        </div>
      </div>
      <div className="bt-leg"><p>{LEGEND}</p></div>
    </div>
  )
}
