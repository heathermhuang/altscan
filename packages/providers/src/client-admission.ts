import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A per-client budget charged only on BILLED provider calls (audit lead B4). The adapter decides whether a call is
 * billed (a response-cache miss) deep inside each method, so the caller cannot charge it from outside without charging
 * cache hits too. Instead the caller runs the provider call inside `withClientAdmission`, and the adapter asks the
 * stored `admit` right before it spends: false refuses that call as 'rate_limited', which every caller already
 * degrades to the local-index view. Outside a `withClientAdmission` (the indexer, server renders) nothing changes.
 */
export type ClientAdmission = {
  /** Charge the client for one billed call; false refuses it. */
  admit: () => Promise<boolean>
  /** Give the charge back: the fleet-wide admission refused the call after the client paid for it. */
  release: () => Promise<void>
}

const store = new AsyncLocalStorage<ClientAdmission>()

export function withClientAdmission<T>(admit: ClientAdmission, fn: () => Promise<T>): Promise<T> {
  return store.run(admit, fn)
}

export function currentClientAdmission(): ClientAdmission | undefined {
  return store.getStore()
}
