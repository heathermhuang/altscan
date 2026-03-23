'use client'
import { useState } from 'react'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-2 text-gray-400 hover:text-indigo-600 transition-colors text-xs"
      title="Copy to clipboard"
    >
      {copied ? '✓' : '⎘'}
    </button>
  )
}
