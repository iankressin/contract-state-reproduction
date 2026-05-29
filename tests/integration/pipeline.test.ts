import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { TrackedVariable } from '../../src/config.ts'
import { resolvePlans } from '../../src/layout.ts'
import { type RowBatch, buildTrackingContext, processBatch } from '../../src/pipeline.ts'
import { encodeKey, mappingSlot, scalarSlot } from '../../src/slots.ts'
import { APPROVAL_SIG, TRANSFER_SIG, TRANSFER_TOPIC, approvalLog, block, diff, transferLog, word } from '../fixtures.ts'

const CONTRACT = '0x6b175474e89094c44da98b954eedeac495271d0f' as Hex
const A = '0xaa11111111111111111111111111111111111111' as Hex
const B = '0xbb22222222222222222222222222222222222222' as Hex
const S = '0xcc33333333333333333333333333333333333333' as Hex

const TRACKED: TrackedVariable[] = [
  { variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } },
  { variable: 'balanceOf', shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' }, keySources: [{ eventAbi: TRANSFER_SIG, keyTuples: [['from'], ['to']] }] },
  { variable: 'allowance', shape: { slot: 3, keyTypes: ['address', 'address'], valueType: 'uint256' }, keySources: [{ eventAbi: APPROVAL_SIG, keyTuples: [['owner', 'spender']] }] },
]

const balSlot = (h: Hex) => mappingSlot(2, [encodeKey('address', h)])
const allowSlot = (o: Hex, s: Hex) => mappingSlot(3, [encodeKey('address', o), encodeKey('address', s)])

async function ctx() {
  const plans = await resolvePlans(undefined, TRACKED)
  return buildTrackingContext(CONTRACT, plans, TRACKED)
}
const val = (b: RowBatch, variable: string, key1 = '', key2 = '') => b.valueRows.find((r) => r.variable === variable && r.key1 === key1 && r.key2 === key2)

describe('buildTrackingContext', () => {
  test('indexes scalars, decoders, and events→mappings', async () => {
    const c = await ctx()
    expect(c.scalarSlots.get(scalarSlot(1))).toEqual([{ variable: 'totalSupply' }])
    expect(c.mapByTopic.get(TRANSFER_TOPIC)?.[0]?.plan.variable).toBe('balanceOf')
    expect([...c.decoders.keys()].sort()).toEqual(['allowance', 'balanceOf', 'totalSupply'])
  })
  test('throws when a mapping lacks keySources', async () => {
    const plans = await resolvePlans(undefined, [{ variable: 'balanceOf', shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' } }])
    expect(() => buildTrackingContext(CONTRACT, plans, [{ variable: 'balanceOf', shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' } }])).toThrow(/keySources/)
  })
  test('throws on key-tuple arity mismatch', async () => {
    const bad: TrackedVariable[] = [{ variable: 'allowance', shape: { slot: 3, keyTypes: ['address', 'address'], valueType: 'uint256' }, keySources: [{ eventAbi: APPROVAL_SIG, keyTuples: [['owner']] }] }]
    const plans = await resolvePlans(undefined, bad)
    expect(() => buildTrackingContext(CONTRACT, plans, bad)).toThrow(/depth is 2/)
  })
})

describe('processBatch', () => {
  test('balanceOf: Transfer labels both sides; diffs decode to value rows', async () => {
    const b = processBatch(await ctx(), [
      block(100, { logs: [transferLog(A, B, 100n)], stateDiffs: [diff(balSlot(A), word(50)), diff(balSlot(B), word(100))] }),
    ])
    expect(b.stateRows).toHaveLength(2)
    expect(b.labelRows.map((r) => r.key1).sort()).toEqual([A, B].sort())
    expect(val(b, 'balanceOf', A)?.valueNum).toBe(50n)
    expect(val(b, 'balanceOf', B)?.valueNum).toBe(100n)
    expect(val(b, 'balanceOf', B)?.blockNumber).toBe(100)
  })

  test('allowance: Approval labels the nested key', async () => {
    const b = processBatch(await ctx(), [block(101, { logs: [approvalLog(A, S, 777n)], stateDiffs: [diff(allowSlot(A, S), word(777))] })])
    const row = val(b, 'allowance', A, S)
    expect(row?.valueNum).toBe(777n)
  })

  test('totalSupply: scalar slot decodes with empty keys', async () => {
    const b = processBatch(await ctx(), [block(102, { stateDiffs: [diff(scalarSlot(1), word(999))] })])
    expect(val(b, 'totalSupply')?.valueNum).toBe(999n)
  })

  test('account-level keys are skipped; unlabeled slots stay raw-only', async () => {
    const random = `0x${'9'.repeat(64)}` as Hex
    const b = processBatch(await ctx(), [block(103, { stateDiffs: [diff('balance', word(1)), diff('nonce', word(2)), diff(random, word(3))] })])
    expect(b.stateRows).toHaveLength(1) // only the storage slot, not balance/nonce
    expect(b.stateRows[0]?.slot).toBe(random)
    expect(b.valueRows).toHaveLength(0) // random slot isn't labeled
  })

  test('deleted slot (no next) decodes to zero', async () => {
    const b = processBatch(await ctx(), [
      block(104, { logs: [transferLog(A, B, 0n)], stateDiffs: [diff(balSlot(B), undefined, { kind: '-' })] }),
    ])
    expect(val(b, 'balanceOf', B)?.valueNum).toBe(0n)
    expect(b.stateRows[0]?.value).toBeNull()
  })
})
