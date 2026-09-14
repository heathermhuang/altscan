import { describe, expect, it } from 'vitest'
import { decodeV2Swap, SWAP_V2_TOPIC } from './dex-swap'

// Real Swap logs, read from each chain's RPC on 2026-09-14 together with the
// pair's token0()/token1(). The expected amounts were decoded independently of
// the implementation, by splitting `data` into 32-byte words.

// PancakeSwap V2 pair 0xc2e278b686049ffb0cc42225b1a48b5904f66d44, tx 0x5be5297cd633e18ecb158921b2eb4d935f01c9b3199f0c5f8da3677c6abf4888 (block 121744349, log 862)
const BSC_TOKENS: [string, string] = ['0x205812cdbed920aff76c6580abd681a46d11efc7', '0x4a13b0a37a1119477b2da4786133ebf618e37777']
const BSC_SWAP = {
  topics: [
    '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
    '0x0000000000000000000000001de460f363af910f51726def188f9004276bf4bc',
    '0x000000000000000000000000db6b44b8c462682054ac11a58ef1b31b635b3b72'
  ],
  data: '0x00000000000000000000000000000000000000000000000000005ba279e2c4c700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000058b3609dccef3ca7ec'
}

// Uniswap V2 pair 0x93f768b3daa607370280cb0f69375adca14e5fd5, tx 0xf3a52ef6f935342f69226f4eecc547234a4b514c0d1bcc399fbe7363c17671b2 (block 25972238, log 103)
const ETH_TOKENS: [string, string] = ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xc8168d5665f4418353728ac970713e09c0b7c20e']
const ETH_SWAP = {
  topics: [
    '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
    '0x00000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af',
    '0x00000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af'
  ],
  data: '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002ecc4bcd1774d141acbeeff950000000000000000000000000000000000000000000000000f023b863df0c1520000000000000000000000000000000000000000000000000000000000000000'
}

describe('decodeV2Swap', () => {
  it('is keyed on the event every V2 fork emits', () => {
    expect(BSC_SWAP.topics[0]).toBe(SWAP_V2_TOPIC)
    expect(ETH_SWAP.topics[0]).toBe(SWAP_V2_TOPIC)
  })

  // sender and to are indexed, so `data` is exactly the four uint256 amounts:
  // 128 bytes, 256 hex chars plus "0x". A guard demanding 514 rejected every
  // real swap on both chains, and dex_trades received no rows at all.
  it('decodes a real PancakeSwap V2 swap on BSC (token0 in)', () => {
    expect(BSC_SWAP.data).toHaveLength(258)
    expect(decodeV2Swap(BSC_SWAP, BSC_TOKENS)).toEqual({ tokenIn: '0x205812cdbed920aff76c6580abd681a46d11efc7', tokenOut: '0x4a13b0a37a1119477b2da4786133ebf618e37777', amountIn: '100753387734215', amountOut: '1636238982920506484716', maker: '0xdb6b44b8c462682054ac11a58ef1b31b635b3b72' })
  })

  it('decodes a real Uniswap V2 swap on Ethereum (token1 in)', () => {
    expect(ETH_SWAP.data).toHaveLength(258)
    expect(decodeV2Swap(ETH_SWAP, ETH_TOKENS)).toEqual({ tokenIn: '0xc8168d5665f4418353728ac970713e09c0b7c20e', tokenOut: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', amountIn: '231732628475875418992018390933', amountOut: '1081492308273185106', maker: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' })
  })

  it('rejects a log without both indexed addresses', () => {
    expect(decodeV2Swap({ ...BSC_SWAP, topics: BSC_SWAP.topics.slice(0, 2) }, BSC_TOKENS)).toBeNull()
  })

  it('rejects data too short to hold all four amounts', () => {
    expect(decodeV2Swap({ ...BSC_SWAP, data: BSC_SWAP.data.slice(0, 2 + 3 * 64) }, BSC_TOKENS)).toBeNull()
  })
})
