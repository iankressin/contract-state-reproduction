import { describe, expect, test } from 'vitest'
import type { Hex } from 'viem'
import type { TrackedVariable } from '../../src/config.ts'
import { resolvePlans } from '../../src/layout.ts'
import { type BlockInput, buildTrackingContext } from '../../src/pipeline.ts'
import { MemorySink } from '../../src/sink.ts'
import { encodeKey, mappingSlot } from '../../src/slots.ts'
import { block, diff, transferLog, word } from '../fixtures.ts'

const CONTRACT = '0x6b175474e89094c44da98b954eedeac495271d0f' as Hex
const A = '0xaa11111111111111111111111111111111111111' as Hex
const B = '0xbb22222222222222222222222222222222222222' as Hex
const balSlot = (h: Hex) => mappingSlot(2, [encodeKey('address', h)])

const TRACKED: TrackedVariable[] = [
  {
    variable: 'balanceOf',
    shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' },
    keySources: [{ eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)', keyTuples: [['from'], ['to']] }],
  },
]

async function* fakeStream(...batches: BlockInput[][]) {
  for (const data of batches) yield { data }
}

describe('MemorySink', () => {
  test('consumes a stream and collects decoded rows (no DB, no network)', async () => {
    const plans = await resolvePlans(undefined, TRACKED)
    const ctx = buildTrackingContext(CONTRACT, plans, TRACKED)
    const sink = new MemorySink()

    await sink.consume(
      fakeStream(
        [block(100, { logs: [transferLog(A, B, 100n)], stateDiffs: [diff(balSlot(B), word(100))] })],
        [block(101, { logs: [transferLog(B, A, 30n)], stateDiffs: [diff(balSlot(B), word(70)), diff(balSlot(A), word(30))] })],
      ),
      ctx,
    )

    expect(sink.batches).toHaveLength(2) // one RowBatch per stream chunk
    expect(sink.rows.stateRows).toHaveLength(3)
    expect(sink.rows.valueRows.find((r) => r.key1 === A)?.valueNum).toBe(30n)
    // B's latest value (block 101) reflects the second batch.
    const bRows = sink.rows.valueRows.filter((r) => r.key1 === B).sort((x, y) => x.blockNumber - y.blockNumber)
    expect(bRows.at(-1)?.valueNum).toBe(70n)
  })
})
