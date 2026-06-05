import { describe, expect, test, vi } from 'vitest'
import type { Hex } from 'viem'
import type { TrackedVariable } from '../../src/config.ts'
import { ConfigError, ContractStateError, DecodingError, SinkError } from '../../src/errors.ts'
import { resolvePlans } from '../../src/layout.ts'
import { createLogger, newStats } from '../../src/observability.ts'
import { type BlockInput, buildTrackingContext } from '../../src/pipeline.ts'
import { type BlockStream, MemorySink, PostgresSink, reorgInfoFrom } from '../../src/sink.ts'
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

// PostgresSink's abort-classification + error-wrapping catch, exercised OFFLINE (no real Postgres).
// `consume` builds the REAL Drizzle target — which only checks for `db.$client` at construction and
// never touches it unless its own write() drives the stream — so a stub db with `$client: {}` lets the
// real target build, and a fake `pipeTo` (which ignores the target and rejects) routes us straight
// into the catch. retry.maxAttempts=1 keeps every case instant (first attempt is also the last → no
// backoff sleeps; abort/library errors are non-retryable anyway). A no-op async iterator satisfies the
// `BlockStream` (AsyncIterable) shape; only `pipeTo` is invoked here. The reorg DISPATCH semantics live
// in the pure `reorgInfoFrom` helper, unit-tested separately below (and end-to-end by the gated e2e).
describe('PostgresSink.consume (offline: abort classification + error wrapping)', () => {
  // The real drizzleTarget needs `db.$client` to exist; it is never used because write() never runs.
  const fakeDb = { $client: {} } as unknown as ConstructorParameters<typeof PostgresSink>[0]
  const makeSink = () => new PostgresSink(fakeDb)

  /** A BlockStream whose `pipeTo` rejects with `err`; its async iterator yields nothing. */
  function rejectingStream(err: unknown): BlockStream {
    return {
      pipeTo: () => Promise.reject(err),
      // A no-op async iterator — consume only calls pipeTo on this path, never iterates.
      async *[Symbol.asyncIterator]() {},
    }
  }

  const ctx = { contract: CONTRACT, scalarSlots: new Map(), decoders: new Map(), mapByTopic: new Map() }
  const opts = (run: Record<string, unknown> = {}) => ({ run: { retry: { maxAttempts: 1 }, ...run }, logger: createLogger('silent'), stats: newStats() })

  test('AbortError from pipeTo resolves CLEANLY (not a throw, not a SinkError)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await expect(makeSink().consume(rejectingStream(abort), ctx, opts())).resolves.toBeUndefined()
  })

  test('unknown error from pipeTo rejects with SinkError(SINK_CONSUME_FAILED) wrapping the cause', async () => {
    const boom = new Error('boom')
    const onError = vi.fn()
    const consuming = makeSink().consume(rejectingStream(boom), ctx, opts({ onError }))

    await expect(consuming).rejects.toBeInstanceOf(SinkError)
    await expect(consuming).rejects.toMatchObject({ code: 'SINK_CONSUME_FAILED', cause: boom })
    // The unknown-error branch dispatches onError with the ORIGINAL cause before wrapping + rethrowing.
    expect(onError).toHaveBeenCalledWith(boom)
  })

  test('a typed ContractStateError (DecodingError/ConfigError) passes through UNWRAPPED', async () => {
    const decodeErr = new DecodingError('bad', 'DECODE_EVENT_FAILED')
    const configErr = new ConfigError('bad', 'CONFIG_NO_ADDRESS')

    // The SAME instance is rethrown (NOT wrapped in a SinkError) so callers keep branching on `.code`.
    await expect(makeSink().consume(rejectingStream(decodeErr), ctx, opts())).rejects.toBe(decodeErr)
    await expect(makeSink().consume(rejectingStream(configErr), ctx, opts())).rejects.toBe(configErr)
    // A passthrough is still a ContractStateError, and specifically never a SinkError.
    await expect(makeSink().consume(rejectingStream(decodeErr), ctx, opts())).rejects.toSatisfy(
      (e: unknown) => e instanceof ContractStateError && !(e instanceof SinkError),
    )
  })

  test('missing pipeTo on the stream throws SinkError(SINK_NO_PIPETO) up front', async () => {
    // A bare async-iterable with NO pipeTo — the consume guard must fire before any pipe attempt.
    const noPipe = { async *[Symbol.asyncIterator]() {} } as unknown as BlockStream
    await expect(makeSink().consume(noPipe, ctx, opts())).rejects.toMatchObject({ code: 'SINK_NO_PIPETO' })
  })
})

// The reorg-dispatch semantics, isolated in the pure helper PostgresSink.onAfterRollback delegates to.
// `to` (the SDK's common-ancestor cursor) is authoritative; `from`/`depth` are best-effort — `from` is
// the highest block processed when it is strictly ahead of `to`, else it collapses to `to` (depth 0).
describe('reorgInfoFrom (best-effort reorg shape)', () => {
  test('lastProcessed ahead of the ancestor → from=lastProcessed, depth=from-to', () => {
    expect(reorgInfoFrom(105, 100)).toEqual({ from: 105, to: 100, depth: 5 })
  })

  test('lastProcessed unknown → from collapses to to, depth 0', () => {
    expect(reorgInfoFrom(undefined, 50)).toEqual({ from: 50, to: 50, depth: 0 })
  })

  test('lastProcessed equal to the ancestor → from=to, depth 0', () => {
    expect(reorgInfoFrom(70, 70)).toEqual({ from: 70, to: 70, depth: 0 })
  })

  test('lastProcessed BEHIND the ancestor (forward jump) → from collapses to to, never negative depth', () => {
    expect(reorgInfoFrom(40, 90)).toEqual({ from: 90, to: 90, depth: 0 })
  })
})
