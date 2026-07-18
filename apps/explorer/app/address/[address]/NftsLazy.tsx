'use client'

import { useEffect, useState } from 'react'
import type { ProviderNft } from '@/lib/providers'

type NftsResponse = {
  nfts: ProviderNft[]
  limited?: boolean
  reason?: string
}

export function NftsLazy({ addr }: { addr: string }) {
  const [data, setData] = useState<NftsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/internal/address/${addr}/nfts`)
      .then((r) => r.json())
      .then((d: NftsResponse) => setData(d))
      .catch(() => setData({ nfts: [], limited: true }))
      .finally(() => setLoading(false))
  }, [addr])

  if (loading) {
    return (
      <div className="animate-pulse grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="bg-gray-100 rounded-xl aspect-square" />
        ))}
      </div>
    )
  }

  if (!data || data.limited) {
    const throttled = data?.reason === 'rate_limited' || data?.reason === 'upstream_error'
    return (
      <p className="text-gray-500 py-8 text-center">
        {throttled
          ? 'The data provider is busy right now — NFT activity is temporarily unavailable. Check back in a few minutes.'
          : 'NFT activity is not available for this address.'}
      </p>
    )
  }

  if (data.nfts.length === 0) {
    return (
      <p className="text-gray-500 py-8 text-center">No NFT activity found for this address.</p>
    )
  }

  const nfts = data.nfts

  return (
    <div>
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>Showing current NFT holdings from Moralis.</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {nfts.map(nft => (
          <div key={`${nft.tokenAddress}-${nft.tokenId}`} className="bg-white rounded-xl border shadow-sm overflow-hidden">
            {nft.imageUrl ? (
              <img src={nft.imageUrl} alt={nft.name} loading="lazy" className="w-full aspect-square object-cover" />
            ) : (
              <div className="w-full aspect-square bg-gray-100 flex items-center justify-center text-3xl">🖼️</div>
            )}
            <div className="p-2">
              <p className="text-xs font-semibold truncate">{nft.name} #{nft.tokenId}</p>
              <p className="text-xs text-gray-400">{nft.symbol}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
