import { NextResponse } from 'next/server'

export async function GET() {
  const hasKey = !!process.env.MORALIS_API_KEY
  const keyPrefix = process.env.MORALIS_API_KEY?.slice(0, 8) ?? 'NOT_SET'
  const disabled = process.env.MORALIS_DISABLED === 'true'

  return NextResponse.json({
    hasKey,
    keyPrefix,
    disabled,
    env_keys: Object.keys(process.env).filter(k => k.includes('MORALIS')),
  })
}
