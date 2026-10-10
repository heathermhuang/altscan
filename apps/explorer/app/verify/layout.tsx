import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const metadata: Metadata = {
  title: 'Verify Contract',
  description: `Check whether a ${chainConfig.name} contract is verified on Sourcify, and list it as verified on ${chainConfig.brandDomain} if it is.`,
  alternates: { canonical: '/verify' },
}

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return children
}
