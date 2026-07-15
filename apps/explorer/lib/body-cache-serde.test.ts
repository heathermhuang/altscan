import { describe, expect, it } from 'vitest'
import { bodyCacheKey, serializeTxBody, parseTxBody, type TxBody } from './body-cache-serde'

const sample: TxBody = {
  input: '0xa9059cbb0000',
  logs: [{ address: '0xabc', topic0: '0xddf2', topic1: null, topic2: null, topic3: null, data: '0x01', logIndex: 3 }],
}

describe('body-cache serde', () => {
  it('namespaces + lowercases the cache key', () => {
    expect(bodyCacheKey('0xABC')).toBe('body:tx:0xabc')
  })
  it('round-trips a body', () => {
    expect(parseTxBody(serializeTxBody(sample))).toEqual(sample)
  })
  it('returns null for junk / empty', () => {
    expect(parseTxBody(null)).toBeNull()
    expect(parseTxBody('not json')).toBeNull()
    expect(parseTxBody('{"input":123}')).toBeNull()          // wrong type
    expect(parseTxBody('{"logs":[]}')).toBeNull()            // missing input
  })
})
