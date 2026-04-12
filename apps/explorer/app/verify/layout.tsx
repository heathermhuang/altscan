import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const metadata: Metadata = {
  title: 'Verify Contract',
  description: `Verify and publish smart contract source code on ${chainConfig.name}. Match deployed bytecode against Solidity source on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/verify' },
}

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return children
}
