/**
 * Read a tracked variable's GROUND-TRUTH value from the chain at a block, decoded exactly
 * as the indexer decodes it (same slot derivation + decodeWord), so verification can't drift
 * from the indexer. Used by the verify script and the integration tests.
 */
import type { Hex } from 'viem'
import { type Decoded, decodeWord } from './decode.ts'
import type { Plan } from './layout.ts'
import { encodeKey, mappingSlot } from './slots.ts'

type StorageReader = { getStorageAt: (args: { address: Hex; slot: Hex; blockNumber: bigint }) => Promise<Hex | undefined> }

/** Coerce a stored key string (slot_label/state_value key1/key2) back to the JS value for its ABI type. */
function coerceKey(abiType: string, key: string): unknown {
  if (abiType === 'address' || abiType.startsWith('bytes')) return key as Hex
  if (abiType === 'bool') return key === '1' || key === 'true'
  return BigInt(key) // uintN / intN
}

/** The storage slot a plan occupies (for a mapping, given its display keys). */
export function planSlot(plan: Plan, keys: string[] = []): Hex {
  if (plan.kind === 'scalar') return plan.slot
  return mappingSlot(
    plan.baseSlot,
    plan.keyTypes.map((t, i) => encodeKey(t, coerceKey(t, keys[i]!))),
  )
}

export async function chainValueAt(client: StorageReader, address: Hex, plan: Plan, block: number | bigint, keys: string[] = []): Promise<Decoded> {
  const word = await client.getStorageAt({ address, slot: planSlot(plan, keys), blockNumber: BigInt(block) })
  return decodeWord(word ?? null, plan.value, plan.kind === 'scalar' ? plan.offset : 0, plan.decodeBits)
}
