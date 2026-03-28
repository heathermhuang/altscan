'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function AutoRefresh({ intervalMs = 10000 }: { intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])
  return null
}
