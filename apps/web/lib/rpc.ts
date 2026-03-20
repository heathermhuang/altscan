import { JsonRpcProvider } from 'ethers'

let _provider: JsonRpcProvider | null = null

export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(process.env.BNB_RPC_URL ?? 'https://bsc-dataseed1.binance.org/')
  }
  return _provider
}
