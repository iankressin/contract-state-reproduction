/**
 * EVM storage-slot derivation (Solidity layout rules) for value-typed keys.
 */
import { type Hex, concat, encodeAbiParameters, keccak256, pad, toHex } from 'viem'

/** ABI-encode a value-type mapping key to its 32-byte preimage segment h(k). */
export function encodeKey(abiType: string, value: unknown): Hex {
  return encodeAbiParameters([{ type: abiType }], [value as never])
}

/** Fixed slot of a scalar/value-type state variable. */
export function scalarSlot(baseSlot: number | bigint): Hex {
  return pad(toHex(BigInt(baseSlot)), { size: 32 })
}

/**
 * Slot of a (possibly nested) mapping access. `encodedKeys` are the h(k) segments
 * outer→inner. Solidity: slot_{i} = keccak256(h(k_i) ‖ slot_{i-1}), slot_0 = baseSlot.
 * e.g. allowance[a][b] -> keccak256(h(b) ‖ keccak256(h(a) ‖ p)).
 */
export function mappingSlot(baseSlot: number | bigint, encodedKeys: Hex[]): Hex {
  let slot = pad(toHex(BigInt(baseSlot)), { size: 32 })
  for (const k of encodedKeys) slot = keccak256(concat([k, slot]))
  return slot
}

/** Human-readable form of a mapping key value, for the `key1`/`key2` columns. */
export function keyDisplay(abiType: string, value: unknown): string {
  if (abiType === 'address' || abiType.startsWith('bytes')) return String(value).toLowerCase()
  if (abiType === 'bool') return value ? '1' : '0'
  return String(value) // uint/int -> decimal
}
