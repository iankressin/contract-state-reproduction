import { describe, expect, test } from 'bun:test'
import { type Hex, pad, toHex } from 'viem'
import { decodeWord } from '../../src/decode.ts'

const w = (n: bigint | number): Hex => pad(toHex(BigInt(n)), { size: 32 })

describe('decodeWord — numeric', () => {
  test('uint256 full word', () => {
    expect(decodeWord(w(1000), { category: 'uint', bytes: 32 })).toEqual({ num: 1000n, hex: null })
  })
  test('uint8 packed at offset 1', () => {
    // byte at index 1 (from the right) = 0xab
    expect(decodeWord(w(0xab00), { category: 'uint', bytes: 1 }, 1)).toEqual({ num: 0xabn, hex: null })
  })
  test('int8 sign extension', () => {
    expect(decodeWord(w(0xff), { category: 'int', bytes: 1 })).toEqual({ num: -1n, hex: null })
    expect(decodeWord(w(0x7f), { category: 'int', bytes: 1 })).toEqual({ num: 127n, hex: null })
  })
  test('int256 of 2^256-1 is -1', () => {
    expect(decodeWord(w((1n << 256n) - 1n), { category: 'int', bytes: 32 }).num).toBe(-1n)
  })
  test('bool', () => {
    expect(decodeWord(w(0), { category: 'bool', bytes: 1 }).num).toBe(0n)
    expect(decodeWord(w(5), { category: 'bool', bytes: 1 }).num).toBe(1n)
  })
  test('low-bit mask strips packed high bits (USDC v2.2 style)', () => {
    const packed = (1n << 255n) | 123n
    expect(decodeWord(w(packed), { category: 'uint', bytes: 32 }, 0, 255).num).toBe(123n)
    expect(decodeWord(w(packed), { category: 'uint', bytes: 32 }).num).toBe(packed) // no mask
  })
})

describe('decodeWord — hex types', () => {
  test('address takes the low 20 bytes', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678' as Hex
    expect(decodeWord(pad(addr, { size: 32 }), { category: 'address', bytes: 20 })).toEqual({ num: null, hex: addr })
  })
  test('bytesN is left-aligned (high bytes)', () => {
    const word = `0xdeadbeef${'0'.repeat(56)}` as Hex
    expect(decodeWord(word, { category: 'bytes', bytes: 4 })).toEqual({ num: null, hex: '0xdeadbeef' })
  })
})

describe('decodeWord — empty/zero', () => {
  test('null/undefined/0x decode to zero per type', () => {
    expect(decodeWord(null, { category: 'uint', bytes: 32 }).num).toBe(0n)
    expect(decodeWord(undefined, { category: 'uint', bytes: 32 }).num).toBe(0n)
    expect(decodeWord('0x', { category: 'uint', bytes: 32 }).num).toBe(0n)
    expect(decodeWord(null, { category: 'address', bytes: 20 }).hex).toBe(`0x${'0'.repeat(40)}`)
    expect(decodeWord(null, { category: 'bytes', bytes: 4 }).hex).toBe('0x00000000')
  })
})
