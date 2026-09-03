import { describe, it, expect } from 'vitest'
import { decodeTransferLogs, decodeNftTransferLogs, TRANSFER_TOPIC0 } from './erc20-transfers'

// Real logs from Ethereum tx 0x0efa479c…e4c4 (block 25736759), fetched from a
// node. Etherscan reports this tx as 20 logs / 18 ERC-20 transfers; the first
// entry below is the 4,280 USDC transfer it shows at the top of that list.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const realLogs = [
  {
    address: USDC,
    topic0: TRANSFER_TOPIC0,
    topic1: '0x000000000000000000000000a9d1e08c7793af67e9d92fe308d5697fb81d3e43',
    topic2: '0x000000000000000000000000e9c43c6e9010c721611d5560407c027292b1ab11',
    topic3: null,
    data: '0x00000000000000000000000000000000000000000000000000000000ff1b9e00',
  },
  {
    address: USDC,
    topic0: TRANSFER_TOPIC0,
    topic1: '0x000000000000000000000000a9d1e08c7793af67e9d92fe308d5697fb81d3e43',
    topic2: '0x000000000000000000000000e17f7455f4dbc5a0121e8bf3ef72571de2da48a2',
    topic3: null,
    data: '0x000000000000000000000000000000000000000000000000000000000bb07777',
  },
  // A non-Transfer event that shares the receipt (this tx has two).
  { address: USDC, topic0: '0xb188237eb0770000000000000000000000000000000000000000000000000000', topic1: null, topic2: null, topic3: null, data: '0x' },
]

describe('decodeTransferLogs', () => {
  it('decodes real ERC-20 Transfer logs to the amounts Etherscan shows', () => {
    const out = decodeTransferLogs(realLogs)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      tokenAddress: USDC,
      fromAddress: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
      toAddress: '0xe9c43c6e9010c721611d5560407c027292b1ab11',
      value: '4280000000', // 4,280 USDC at 6 decimals
    })
    expect(out[1].value).toBe('196114295') // 196.114295 USDC
  })

  it('ignores logs that are not Transfer events', () => {
    expect(decodeTransferLogs([realLogs[2]])).toEqual([])
  })

  // ERC-721 Transfer has the SAME topic0 but indexes tokenId as a 4th topic.
  // Treating one as fungible would print a tokenId where an amount belongs.
  it('skips ERC-721 transfers, which share topic0 but carry a 4th topic', () => {
    expect(decodeTransferLogs([{
      ...realLogs[0],
      topic3: '0x0000000000000000000000000000000000000000000000000000000000000001',
      data: '0x',
    }])).toEqual([])
  })

  it('skips malformed logs rather than throwing mid-render', () => {
    expect(decodeTransferLogs([
      { ...realLogs[0], topic1: null },                    // no sender
      { ...realLogs[0], topic2: null },                    // no recipient
      { ...realLogs[0], data: '0x' },                      // no value word
      { ...realLogs[0], data: 'not-hex' },
      { ...realLogs[0], topic1: '0xshort' },
    ])).toEqual([])
  })

  it('lowercases addresses so they match the DB primary key', () => {
    const [t] = decodeTransferLogs([{ ...realLogs[0], address: USDC.toUpperCase().replace('0X', '0x') }])
    expect(t.tokenAddress).toBe(USDC)
  })

  it('reads only the first 32-byte word when a Transfer carries extra data', () => {
    const [t] = decodeTransferLogs([{
      ...realLogs[0],
      data: '0x00000000000000000000000000000000000000000000000000000000ff1b9e00' + 'ff'.repeat(32),
    }])
    expect(t.value).toBe('4280000000')
  })
})

describe('decodeNftTransferLogs', () => {
  const nftLog = {
    address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
    topic0: TRANSFER_TOPIC0,
    topic1: '0x000000000000000000000000a9d1e08c7793af67e9d92fe308d5697fb81d3e43',
    topic2: '0x000000000000000000000000e9c43c6e9010c721611d5560407c027292b1ab11',
    topic3: '0x00000000000000000000000000000000000000000000000000000000000004d2',
    data: '0x',
  }

  it('decodes a 4-topic Transfer as an NFT with its tokenId', () => {
    expect(decodeNftTransferLogs([nftLog])).toEqual([{
      tokenAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
      fromAddress: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
      toAddress: '0xe9c43c6e9010c721611d5560407c027292b1ab11',
      tokenId: '1234',
    }])
  })

  // The two decoders must partition the same log set — never double-count a
  // transfer into both sections, never drop one from both.
  it('partitions cleanly against the fungible decoder', () => {
    const mixed = [...realLogs, nftLog]
    const fungible = decodeTransferLogs(mixed)
    const nfts = decodeNftTransferLogs(mixed)
    expect(fungible).toHaveLength(2)
    expect(nfts).toHaveLength(1)
    const transferLogCount = mixed.filter((l) => l.topic0 === TRANSFER_TOPIC0).length
    expect(fungible.length + nfts.length).toBe(transferLogCount)
  })

  it('skips malformed NFT logs rather than throwing', () => {
    expect(decodeNftTransferLogs([{ ...nftLog, topic3: '0xnope' }])).toEqual([])
    expect(decodeNftTransferLogs([{ ...nftLog, topic1: null }])).toEqual([])
  })
})
