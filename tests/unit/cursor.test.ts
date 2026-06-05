import { describe, expect, test } from 'vitest'
import { MemoryCursor, withCursor } from '../../src/cursor.ts'
import type { BlockInput } from '../../src/pipeline.ts'
import type { BlockStream } from '../../src/sink.ts'

/** A minimal BlockInput carrying only the header height the cursor logic reads. */
const block = (number: number): BlockInput => ({ header: { number, timestamp: 0 }, logs: [], stateDiffs: [] })

/** An async-iterable BlockStream over the given batches (each batch an array of block heights). */
function streamOf(batches: number[][]): BlockStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const heights of batches) yield { data: heights.map(block) }
    },
  } as BlockStream
}

/** Collect a withCursor() result into batches of block heights for easy assertions. */
async function drain(stream: AsyncIterable<{ data: BlockInput[] }>): Promise<number[][]> {
  const out: number[][] = []
  for await (const { data } of stream) out.push(data.map((b) => b.header.number))
  return out
}

describe('MemoryCursor', () => {
  test('round-trips: unset → undefined, then load reflects the last save', async () => {
    const cursor = new MemoryCursor()
    expect(await cursor.load()).toBeUndefined()
    await cursor.save(42)
    expect(await cursor.load()).toBe(42)
    await cursor.save(100)
    expect(await cursor.load()).toBe(100)
  })

  test('honors an initial seed', async () => {
    expect(await new MemoryCursor(7).load()).toBe(7)
  })
})

describe('withCursor', () => {
  test('undefined resume position passes every batch through unchanged', async () => {
    const result = await drain(withCursor(streamOf([[1, 2], [3]]), undefined))
    expect(result).toEqual([[1, 2], [3]])
  })

  test('skips blocks at/below the resume position and drops fully-consumed batches', async () => {
    // resumeAfter = 2 ⇒ keep > 2 only. Batch [1,2] fully skipped (dropped), [3,4] kept.
    const result = await drain(
      withCursor(
        streamOf([
          [1, 2],
          [3, 4],
        ]),
        2,
      ),
    )
    expect(result).toEqual([[3, 4]])
  })

  test('partially filters a straddling batch, preserving order', async () => {
    const result = await drain(withCursor(streamOf([[1, 2, 3, 4]]), 2))
    expect(result).toEqual([[3, 4]])
  })
})
