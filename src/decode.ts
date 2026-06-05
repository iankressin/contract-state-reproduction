/**
 * Decode a raw 32-byte storage word into a typed value.
 *
 * Returns { num, hex }: numeric types (uint/int/bool/enum) populate `num`; address and
 * bytesN populate `hex`. Honors a packing `offset` (bytes from the slot's right) and an
 * optional app-level low-bit mask (`bits`, e.g. USDC v2.2 packs a flag in bit 255).
 */
import { type Hex, hexToBigInt } from 'viem'
import type { ValueType } from './layout.ts'

export type Decoded = { num: bigint | null; hex: string | null }

export function decodeWord(word: Hex | null | undefined, value: ValueType, offset = 0, bits?: number): Decoded {
  const w = (!word || word === '0x' ? `0x${'0'.repeat(64)}` : word) as Hex

  if (value.category === 'bytes') {
    // Fixed bytesN is left-aligned (high-order). Only offset 0 is supported here.
    const hex = `0x${w
      .slice(2)
      .padStart(64, '0')
      .slice(0, value.bytes * 2)}`
    return { num: null, hex }
  }

  let v = hexToBigInt(w) >> BigInt(offset * 8)
  v &= (1n << BigInt(value.bytes * 8)) - 1n
  if (bits != null && bits < value.bytes * 8) v &= (1n << BigInt(bits)) - 1n

  if (value.category === 'int') {
    const signBit = 1n << BigInt(value.bytes * 8 - 1)
    if (v & signBit) v -= 1n << BigInt(value.bytes * 8)
  }
  if (value.category === 'address') return { num: null, hex: `0x${v.toString(16).padStart(40, '0')}` }
  if (value.category === 'bool') return { num: v === 0n ? 0n : 1n, hex: null }
  return { num: v, hex: null } // uint, int, enum
}
