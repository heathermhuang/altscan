'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export function AutoRefresh({ intervalMs = 10000 }: { intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(t)
  }, [router, intervalMs])
  return null
}
