/**
 * Example: how a tracked `mapping(...)` discovers its KEYS from events (the `.keysFrom(...)` seam).
 *
 *   npx tsx examples/event-keys.ts
 *
 * Storage mappings have no on-chain enumeration: a `mapping(address => uint256) balanceOf` write
 * lands at `keccak256(h(holder) ‖ slot)`, and the chain never tells you which `holder` that was. So
 * to label a mapping write with a human-readable key we read it back OUT of the events the contract
 * emits. `.keysFrom(eventSignature, keyPaths)` declares that binding:
 *
 *   mapping('balanceOf', { slot: 2, keys: ['address'],          value: 'uint256' })
 *     .keysFrom('event Transfer(address indexed from, address indexed to, uint256 value)',
 *               [['from'], ['to']])         // TWO single-arg paths → balanceOf[from], balanceOf[to]
 *
 *   mapping('allowance', { slot: 3, keys: ['address','address'], value: 'uint256' })
 *     .keysFrom('event Approval(address indexed owner, address indexed spender, uint256 value)',
 *               [['owner', 'spender']])     // ONE two-arg path → allowance[owner][spender]
 *
 * Each entry in `keyPaths` is a TUPLE of event-arg names whose length must equal the mapping depth
 * (1 for `balanceOf`, 2 for `allowance`). Per matching log, every tuple is resolved against the
 * decoded args, ABI-encoded, and combined into the mapping slot; the decoded arg values become the
 * `key1` / `key2` columns of `state_value` (key2 is '' for a single-key mapping).
 *
 * This runs fully OFFLINE: we decode hand-built sample logs and print the derived key tuples + the
 * storage slots they resolve to — no Portal / RPC / DB, exits 0.
 *
 * In your own project, import the public surface from '@iankressin/contract-state'. `mapping` is
 * public; the three internals below — `makeEventReader` (event decode), `encodeKey`/`mappingSlot`
 * (slot math), `keyDisplay` (the key1/key2 string) — are what the pipeline calls for you when it
 * processes a batch. We call them directly here only to make the key-derivation visible step by step
 * (same "reach into ../src for a focused demo" pattern as examples/uniswap-v3-pool.ts).
 */
import { encodeAbiParameters, pad, type Hex } from 'viem'
// ── Public surface (in your project: '@iankressin/contract-state') ──
import { mapping } from '../src/index.ts'
// ── Internals the pipeline calls for you (used here to expose each step of key derivation) ──
import { makeEventReader } from '../src/events.ts'
import { encodeKey, keyDisplay, mappingSlot } from '../src/slots.ts'
import type { KeySource } from '../src/config.ts'

const OWNER = '0xaa11111111111111111111111111111111111111' as Hex
const SPENDER = '0xbb22222222222222222222222222222222222222' as Hex
const RECIPIENT = '0xcc33333333333333333333333333333333333333' as Hex

/** Build a log for an event with two indexed addresses + a uint256 in data (Transfer/Approval shape). */
function indexedAddrLog(topic0: Hex, a: Hex, b: Hex, value: bigint): { topics: Hex[]; data: Hex } {
  return { topics: [topic0, pad(a, { size: 32 }), pad(b, { size: 32 })], data: encodeAbiParameters([{ type: 'uint256' }], [value]) }
}

/**
 * Resolve a `KeySource` (an event signature + its key-paths) against ONE decoded log, printing the
 * key tuple(s) it yields and the storage slot each lands at. This mirrors what `processBatch` does
 * in its "pass 1: learn mapping slot → (variable, key1, key2)" loop.
 */
function deriveKeys(label: string, baseSlot: number, keyTypes: string[], source: KeySource, log: { topics: Hex[]; data: Hex }) {
  console.log(`\n${label}`)
  console.log(`  event:    ${source.eventAbi}`)
  console.log(`  keyPaths: ${JSON.stringify(source.keyTuples)}   (mapping depth ${keyTypes.length})`)

  // 1) Decode the log's named args from its signature (returns null if topic0 doesn't match).
  const reader = makeEventReader(source.eventAbi)
  const args = reader.decode(log)
  if (!args) {
    console.log('  (log topic0 did not match this event — nothing to derive)')
    return
  }

  // 2) For each key-path tuple, pull the named args, ABI-encode them, and combine into the slot.
  for (const tuple of source.keyTuples) {
    const encoded: Hex[] = []
    const display: string[] = []
    for (let i = 0; i < tuple.length; i++) {
      const argName = tuple[i]!
      const value = args[argName] // the decoded event arg, e.g. the `from` address
      encoded.push(encodeKey(keyTypes[i]!, value)) // h(k): the 32-byte ABI-encoded key segment
      display.push(keyDisplay(keyTypes[i]!, value)) // the human-readable key1/key2 column value
    }
    // Solidity nesting: slot_i = keccak256(h(k_i) ‖ slot_{i-1}), slot_0 = baseSlot.
    const slot = mappingSlot(baseSlot, encoded)
    const key1 = display[0] ?? ''
    const key2 = display[1] ?? '' // '' for a single-key mapping
    const access = tuple.map((t) => `${t}=${args[t]}`).join('][')
    console.log(`    via [${access}]  →  key1=${key1}  key2=${key2 || "''"}`)
    console.log(`        state_value row keyed (key1,key2) above; storage slot ${slot}`)
  }
}

// ── balanceOf: single-key mapping, keyed off Transfer(from, to) ──
// Authored with the public builder; `.keysFrom` records the event + key-paths on the spec, which we
// read back via `._tracked.keySources` to drive the offline derivation below.
const TRANSFER_SIG = 'event Transfer(address indexed from, address indexed to, uint256 value)'
const balanceOf = mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' }).keysFrom(TRANSFER_SIG, [['from'], ['to']])
const transferTopic = makeEventReader(TRANSFER_SIG).topic0

console.log('How mapping keys are extracted from events')
console.log('==========================================')

// A single Transfer(OWNER → RECIPIENT, 100) produces TWO balanceOf keys (one per key-path tuple):
// balanceOf[from] and balanceOf[to] both move when value is transferred.
deriveKeys(
  'balanceOf — mapping(address => uint256) @ slot 2, keyed from Transfer',
  2,
  ['address'],
  balanceOf._tracked.keySources![0]!,
  indexedAddrLog(transferTopic, OWNER, RECIPIENT, 100n),
)

// ── allowance: nested mapping, keyed off Approval(owner, spender) ──
// ONE two-arg key-path → allowance[owner][spender]; both args come from the SAME event.
const APPROVAL_SIG = 'event Approval(address indexed owner, address indexed spender, uint256 value)'
const allowance = mapping('allowance', { slot: 3, keys: ['address', 'address'], value: 'uint256' }).keysFrom(APPROVAL_SIG, [['owner', 'spender']])
const approvalTopic = makeEventReader(APPROVAL_SIG).topic0

deriveKeys(
  'allowance — mapping(address => mapping(address => uint256)) @ slot 3, keyed from Approval',
  3,
  ['address', 'address'],
  allowance._tracked.keySources![0]!,
  indexedAddrLog(approvalTopic, OWNER, SPENDER, 500n),
)

// ── Recap: key-path tuples → key1/key2 ──
console.log('\nRecap')
console.log('  • Each keyPaths tuple = the event-arg names for ONE mapping access; its length == mapping depth.')
console.log("  • balanceOf depth 1 → [['from'],['to']] = two single-key accesses → key2 is always ''.")
console.log("  • allowance depth 2 → [['owner','spender']] = one nested access → key1=owner, key2=spender.")
console.log('  • A storage write at the derived slot is then labeled with (key1,key2) in state_value.')

// Fail loudly if the derivation seam ever regresses (the slot must match the manual computation).
const expectedFromSlot = mappingSlot(2, [encodeKey('address', OWNER)])
const got = makeEventReader(TRANSFER_SIG).decode(indexedAddrLog(transferTopic, OWNER, RECIPIENT, 100n))!
if (keyDisplay('address', got.from) !== OWNER.toLowerCase()) throw new Error('key1 derivation mismatch for balanceOf[from]')
if (mappingSlot(2, [encodeKey('address', got.from)]) !== expectedFromSlot) throw new Error('slot derivation mismatch for balanceOf[from]')
console.log('\nOK — derived keys + slots match the manual computation.')
