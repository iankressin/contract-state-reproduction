/**
 * VERIFY-2: solc-js layout → decode-plan resolution for scalar, mapping, and nested
 * mapping shapes, plus slot-math cross-checks (offline, no chain).
 *
 *   pnpm exec tsx scripts/verify-layout.ts
 */
import { type Hex, encodeAbiParameters, keccak256 } from 'viem'
import { resolvePlans } from '../src/layout.ts'
import { encodeKey, mappingSlot } from '../src/slots.ts'

const plans = await resolvePlans({ path: 'contracts/TestToken.sol', contractName: 'TestToken' }, [
  { variable: '_totalSupply' },
  { variable: '_balances' },
  { variable: '_allowances' },
])
const byName = Object.fromEntries(plans.map((p) => [p.variable, p]))

console.log('Resolved plans:')
for (const p of plans) {
  const v = `${p.value.category}${p.value.bytes * 8}`
  console.log(p.kind === 'scalar' ? `  ${p.variable}: scalar ${v} @ slot ${BigInt(p.slot)}` : `  ${p.variable}: mapping[${p.keyTypes.join('][')}] => ${v} @ baseSlot ${p.baseSlot}`)
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

// Scalar
const ts = byName._totalSupply!
assert(ts.kind === 'scalar' && ts.value.category === 'uint' && ts.value.bytes === 32 && BigInt(ts.slot) === 2n, '_totalSupply scalar uint256 @ slot 2')

// Single mapping
const bal = byName._balances!
assert(bal.kind === 'mapping' && bal.baseSlot === 0 && JSON.stringify(bal.keyTypes) === '["address"]' && bal.value.bytes === 32, '_balances mapping[address]=>uint256 @ slot 0')

// Nested mapping
const allow = byName._allowances!
assert(allow.kind === 'mapping' && allow.baseSlot === 1 && JSON.stringify(allow.keyTypes) === '["address","address"]', '_allowances mapping[address][address] @ slot 1')

// Slot-math cross-checks against canonical keccak256(abi.encode(...)).
const a = '0x1111111111111111111111111111111111111111' as Hex
const b = '0x2222222222222222222222222222222222222222' as Hex

const single = mappingSlot(0, [encodeKey('address', a)])
const singleRef = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, 0n]))
assert(single === singleRef, `_balances[a] slot ${single} != ${singleRef}`)

const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, 1n]))
const nestedRef = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [b, inner]))
const nested = mappingSlot(1, [encodeKey('address', a), encodeKey('address', b)])
assert(nested === nestedRef, `_allowances[a][b] slot ${nested} != ${nestedRef}`)

console.log(`\n_balances[a]      -> ${single}`)
console.log(`_allowances[a][b] -> ${nested}`)
console.log('\n✅ VERIFY-2 PASSED: scalar + mapping + nested-mapping plans derived; slot math matches keccak256(abi.encode(...))')
