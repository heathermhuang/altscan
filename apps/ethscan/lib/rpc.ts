import { JsonRpcProvider } from 'ethers'

let _provider: JsonRpcProvider | null = null

export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com')
  }
  return _provider
}
