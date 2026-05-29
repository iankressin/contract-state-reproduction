import { describe, expect, test } from 'bun:test'
import { type Hex, encodeAbiParameters, keccak256, pad, toHex } from 'viem'
import { encodeKey, keyDisplay, mappingSlot, scalarSlot } from '../../src/slots.ts'

const A = '0x1111111111111111111111111111111111111111' as Hex
const B = '0x2222222222222222222222222222222222222222' as Hex

describe('encodeKey', () => {
  test('address is left-padded to 32 bytes', () => {
    expect(encodeKey('address', A)).toBe(pad(A, { size: 32 }))
    expect(encodeKey('address', A)).toBe(encodeAbiParameters([{ type: 'address' }], [A]))
  })
  test('uint256 / bool', () => {
    expect(encodeKey('uint256', 5n)).toBe(pad(toHex(5), { size: 32 }))
    expect(encodeKey('bool', true)).toBe(pad(toHex(1), { size: 32 }))
    expect(encodeKey('bool', false)).toBe(pad(toHex(0), { size: 32 }))
  })
  test('bytes32 is used as-is', () => {
    const h = `0x${'ab'.repeat(32)}` as Hex
    expect(encodeKey('bytes32', h)).toBe(h)
  })
})

describe('scalarSlot', () => {
  test('pads the slot number to 32 bytes', () => {
    expect(scalarSlot(0)).toBe(`0x${'0'.repeat(64)}`)
    expect(scalarSlot(2)).toBe(pad(toHex(2), { size: 32 }))
  })
})

describe('mappingSlot', () => {
  test('no keys returns the base slot', () => {
    expect(mappingSlot(7, [])).toBe(scalarSlot(7))
  })
  test('single key matches keccak256(abi.encode(key, slot))', () => {
    const slot = mappingSlot(2, [encodeKey('address', A)])
    const ref = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [A, 2n]))
    expect(slot).toBe(ref)
  })
  test('nested key matches keccak256(h(b) ‖ keccak256(h(a) ‖ p))', () => {
    const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [A, 1n]))
    const ref = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [B, inner]))
    expect(mappingSlot(1, [encodeKey('address', A), encodeKey('address', B)])).toBe(ref)
  })
})

describe('keyDisplay', () => {
  test('formats per type', () => {
    expect(keyDisplay('address', '0xAbC0000000000000000000000000000000000123')).toBe('0xabc0000000000000000000000000000000000123')
    expect(keyDisplay('uint256', 42n)).toBe('42')
    expect(keyDisplay('bool', true)).toBe('1')
    expect(keyDisplay('bool', false)).toBe('0')
    expect(keyDisplay('bytes32', '0xAA')).toBe('0xaa')
  })
})
