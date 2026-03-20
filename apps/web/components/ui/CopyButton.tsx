'use client'
import { useState } from 'react'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
    }
  }

  return (
    <button onClick={copy} className="text-xs text-gray-400 hover:text-gray-600 ml-1" title="Copy">
      {copied ? '✓' : '⎘'}
    </button>
  )
}
