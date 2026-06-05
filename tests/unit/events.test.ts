import { describe, expect, test } from 'vitest'
import type { Hex } from 'viem'
import { makeEventReader } from '../../src/events.ts'
import { APPROVAL_TOPIC, TRANSFER_SIG, TRANSFER_TOPIC, transferLog } from '../fixtures.ts'

const A = '0x1111111111111111111111111111111111111111' as Hex
const B = '0x2222222222222222222222222222222222222222' as Hex

describe('makeEventReader', () => {
  test('topic0 equals the known ERC-20 Transfer hash', () => {
    const r = makeEventReader(TRANSFER_SIG)
    expect(r.topic0).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
    expect(r.topic0).toBe(TRANSFER_TOPIC) // matches the fixture's viem-derived topic
  })

  test('decodes named args of a matching log', () => {
    const r = makeEventReader(TRANSFER_SIG)
    const args = r.decode(transferLog(A, B, 500n))!
    expect((args.from as string).toLowerCase()).toBe(A)
    expect((args.to as string).toLowerCase()).toBe(B)
    expect(args.value).toBe(500n)
  })

  test('returns null for a non-matching log', () => {
    const r = makeEventReader(TRANSFER_SIG)
    expect(r.decode({ topics: [APPROVAL_TOPIC], data: '0x' })).toBeNull()
    expect(r.decode({ topics: ['0x00'] as Hex[], data: '0x' })).toBeNull()
  })

  test('THROWS (not null) when topic0 matches but the log is corrupt', () => {
    const r = makeEventReader(TRANSFER_SIG)
    // topic0 matches Transfer but the two indexed-address topics are missing → real decode failure,
    // surfaced as a throw so the pipeline can distinguish it from a quiet non-match.
    expect(() => r.decode({ topics: [TRANSFER_TOPIC], data: '0x' })).toThrow()
  })
})
