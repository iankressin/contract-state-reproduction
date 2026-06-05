import { describe, expect, test, vi } from 'vitest'
import type { Hex } from 'viem'
import type { TrackedVariable } from '../../src/config.ts'
import { resolvePlans } from '../../src/layout.ts'
import { createLogger, newStats } from '../../src/observability.ts'
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

  test('progress fires per batch with correct {from,to,rows}; stats accumulate', async () => {
    const plans = await resolvePlans(undefined, TRACKED)
    const ctx = buildTrackingContext(CONTRACT, plans, TRACKED)
    const sink = new MemorySink()
    const stats = newStats()
    const onProgress = vi.fn()

    await sink.consume(
      // batch 1: blocks 100-101. B is labeled by the Transfer in block 100, so BOTH diffs at B's slot
      // (block 100 and block 101) decode → 2 value rows. batch 2: block 205 → 1 value row for A.
      fakeStream(
        [block(100, { logs: [transferLog(A, B, 100n)], stateDiffs: [diff(balSlot(B), word(100))] }), block(101, { stateDiffs: [diff(balSlot(B), word(70))] })],
        [block(205, { logs: [transferLog(B, A, 30n)], stateDiffs: [diff(balSlot(A), word(30))] })],
      ),
      ctx,
      { run: { onProgress }, logger: createLogger('silent'), stats },
    )

    // One progress per batch, in order, with the batch's first/last block height and its row count.
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenNthCalledWith(1, { from: 100, to: 101, rows: 2 })
    expect(onProgress).toHaveBeenNthCalledWith(2, { from: 205, to: 205, rows: 1 })
    // blocks = (101-100+1) + (205-205+1) = 3; rows accumulates the produced value rows (2 + 1).
    expect(stats.blocks).toBe(3)
    expect(stats.rows).toBe(3)
  })

  test('aborting the signal stops at the next batch boundary and resolves cleanly with partial results', async () => {
    const plans = await resolvePlans(undefined, TRACKED)
    const ctx = buildTrackingContext(CONTRACT, plans, TRACKED)
    const sink = new MemorySink()
    const controller = new AbortController()
    const stats = newStats()
    const onProgress = vi.fn()

    // A multi-batch generator that aborts AFTER yielding batch 2, so batch 3 must never be processed.
    async function* abortingStream() {
      yield { data: [block(100, { stateDiffs: [diff(balSlot(A), word(1))] })] }
      yield { data: [block(101, { stateDiffs: [diff(balSlot(A), word(2))] })] }
      controller.abort()
      yield { data: [block(102, { stateDiffs: [diff(balSlot(A), word(3))] })] }
      yield { data: [block(103, { stateDiffs: [diff(balSlot(A), word(4))] })] }
    }

    // Resolves cleanly (no throw) even though the signal aborted mid-stream.
    await expect(
      sink.consume(abortingStream(), ctx, { run: { signal: controller.signal, onProgress }, logger: createLogger('silent'), stats }),
    ).resolves.toBeUndefined()

    // Only the two pre-abort batches were processed; the post-abort batches were skipped.
    expect(sink.batches).toHaveLength(2)
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(stats.blocks).toBe(2)
  })
})
