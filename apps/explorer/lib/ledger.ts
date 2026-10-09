import { safeBigInt } from '@/lib/format'

/** One transaction as the address ledger draws it. */
export interface LedgerRow { t: number; dir: 'in' | 'out'; native: boolean; spam: boolean }

/** The fields both txn sources share: local `transactions` rows and provider `HistoryRow`s. */
export interface LedgerInput {
  time: Date | string
  fromAddress: string
  toAddress: string | null
  value: string | bigint | number | null
  category?: string | null
  possibleSpam?: boolean | null
}

const IN = /receive|deposit|airdrop|mint/
const OUT = /send|withdraw|burn/

/**
 * Normalise a page of rows for the ledger, oldest first. Both sources list newest first, so rows
 * that share a second keep chain order by sorting on time, then on REVERSED input position (the
 * later-listed, older row goes left). Direction: a provider category wins (a "token receive" row's
 * from/to are the token contract's, not this address's); otherwise a row sent TO the address is in
 * and everything else is out (the address sent it, self-sends included). A row with no usable time
 * cannot be placed, and a tape never fakes data: no rows at all then.
 */
export function toLedgerRows(addr: string, rows: LedgerInput[]): LedgerRow[] {
  const a = addr.toLowerCase()
  const drawn = rows
    .map((r, i) => {
      const c = (r.category ?? '').toLowerCase()
      const dir: 'in' | 'out' = IN.test(c) ? 'in'
        : OUT.test(c) ? 'out'
        : (r.toAddress ?? '').toLowerCase() === a && r.fromAddress.toLowerCase() !== a ? 'in'
        : 'out'
      return {
        i,
        t: Math.floor(new Date(r.time).getTime() / 1000),
        dir,
        native: safeBigInt(r.value ?? '0') > 0n,
        spam: !!r.possibleSpam,
      }
    })
  if (drawn.some(r => !Number.isFinite(r.t))) return []
  return drawn.sort((p, q) => p.t - q.t || q.i - p.i).map(({ t, dir, native, spam }) => ({ t, dir, native, spam }))
}

/** A tile's flex weight from the seconds since the previous row: 1 + log2(1 + gap), 2 dp. */
export function ledgerWeight(gapSeconds: number): number {
  return Math.round((1 + Math.log2(1 + Math.max(0, gapSeconds))) * 100) / 100
}

/**
 * "15 seconds", "3 minutes", "2 hours", "3 days". The unit is picked on the ROUNDED count, so each
 * unit ends where the next begins (7199 s is "2 hours", never "120 minutes").
 */
export function formatSpan(seconds: number): string {
  const s = Math.round(Math.max(0, seconds))
  const minutes = Math.round(s / 60)
  const hours = Math.round(s / 3_600)
  const [n, unit] = s < 120 ? [s, 'second'] : minutes < 120 ? [minutes, 'minute']
    : hours < 48 ? [hours, 'hour'] : [Math.round(s / 86_400), 'day']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}
