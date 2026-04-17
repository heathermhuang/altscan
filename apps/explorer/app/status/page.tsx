import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'
import { StatusDashboard } from './StatusDashboard'

export const metadata: Metadata = {
  title: 'Indexer Status',
  description: `Live indexer health for ${chainConfig.brandDomain} — current lag, indexing speed, and catch-up ETA.`,
  alternates: { canonical: '/status' },
}

export const dynamic = 'force-dynamic'

export default function StatusPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold mb-2">Indexer Status</h1>
      <p className="text-gray-600 mb-8 leading-relaxed">
        Live view of the {chainConfig.name} indexer. Updates every 3 seconds.
      </p>
      <StatusDashboard />
    </div>
  )
}
