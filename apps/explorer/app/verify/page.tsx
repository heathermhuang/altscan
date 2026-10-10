import { chainConfig } from '@/lib/chain'
import { AdReserve } from '@/components/ads/AdReserve'
import { VerifyForm } from './VerifyForm'

export const revalidate = false

export default function VerifyPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 *:max-w-3xl">
      <div className="mb-5">
        <p className="k">{'// '}verify</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Check a Contract on Sourcify</h1>
        <p className="mt-2 text-sm text-ink2">
          Look up a contract on{' '}
          <a href="https://sourcify.dev" className="text-acc-ink underline hover:no-underline" target="_blank" rel="noreferrer">
            Sourcify
          </a>
          , the open registry of verified source code, for {chainConfig.name} (chain ID {chainConfig.chainId}). If it has a
          verified match, this explorer lists the contract as verified. This takes an address, not source code: to verify a
          new contract, upload its source on sourcify.dev first.
        </p>
      </div>

      <VerifyForm />

      {/* After the form, so on a phone the form comes first. The placement id is the settings key and keeps its name. */}
      <AdReserve
        context="verify"
        placement="verify_intro"
        variant="compact"
        className="mt-8"
      />
    </div>
  )
}
