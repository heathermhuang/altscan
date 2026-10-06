import { AdReserve } from '@/components/ads/AdReserve'
import { WatchlistView } from './WatchlistView'

export const revalidate = false

export default function WatchlistPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-5">
        <p className="k">{'// '}watchlist</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Watchlist</h1>
      </div>
      <WatchlistView
        emptyAd={
          <AdReserve
            context="watchlist_empty"
            placement="watchlist_empty"
            variant="compact"
            className="mx-auto mt-8 max-w-2xl text-left"
          />
        }
        activeAd={
          <AdReserve
            context="watchlist_active"
            placement="watchlist_active"
            variant="compact"
            className="mt-6"
          />
        }
      />
    </div>
  )
}
