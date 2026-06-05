/**
 * Example: implement a CUSTOM `StateSink` and drive it OFFLINE (no Postgres / Portal / RPC).
 *
 *   npx tsx examples/custom-sink.ts
 *
 * What this teaches:
 *   1. The sink seam. A `StateSink` is just `consume(stream, tracking, options?)`. Inside, you call
 *      `processBatch(tracking, data)` per batch to get decoded rows, then persist them wherever you
 *      like. Here `JsonLinesSink` serializes each value row to NDJSON in an in-memory buffer instead
 *      of a database — but the exact same shape backs a sink that writes to S3, Kafka, SQLite, etc.
 *   2. Resumability with the cursor utility. `MemoryCursor` + `withCursor` let a sink skip blocks it
 *      already processed and advance a high-water mark after each durable write, so a restart resumes
 *      at `cursor + 1` with no duplicates. We prove it by consuming the SAME stream twice: the second
 *      pass starts from the saved cursor and emits nothing.
 *
 * Everything is fed by an OFFLINE fake batch stream built the way the unit tests build theirs
 * (tests/fixtures.ts), so this runs with zero env / network / DB and exits 0.
 *
 * In your own project, import the public surface from '@iankressin/contract-state' (shown below).
 * `processBatch`, `MemoryCursor`/`withCursor`, and the `StateSink`/`BlockStream`/`TrackingContext`
 * types are all public. The two internals used here — `buildTrackingContext` and `resolvePlans` —
 * are what the fluent builder calls under the hood; you normally get a `TrackingContext` by running
 * `ContractState.…`, but we construct one directly so the whole thing stays offline (same pattern as
 * tests/unit/sink.test.ts and examples/uniswap-v3-pool.ts, which also reach into ../src for a focused
 * demo).
 */
import { pad, parseAbiItem, toEventSelector, toHex } from 'viem'
import type { Hex } from 'viem'
// ── Public surface (in your project: '@iankressin/contract-state') ──
import {
  type BlockStream,
  type ConsumeOptions,
  type Cursor,
  MemoryCursor,
  mapping,
  type StateSink,
  type TrackingContext,
  type ValueRow,
  withCursor,
  processBatch,
} from '../src/index.ts'
// ── Internals the fluent builder normally calls for you (kept here to stay fully offline) ──
import type { BlockInput } from '../src/pipeline.ts'
import { buildTrackingContext } from '../src/pipeline.ts'
import { resolvePlans } from '../src/layout.ts'
import { encodeKey, mappingSlot } from '../src/slots.ts'

const CONTRACT = '0x6b175474e89094c44da98b954eedeac495271d0f' as Hex // DAI (any address works offline)

// ── A custom sink: persist decoded value rows as NDJSON (one JSON object per line) ──
//
// The seam is tiny: implement `consume`, run `processBatch` per batch, write the rows somewhere.
// Here "somewhere" is an in-memory string buffer + a row counter — swap those two lines for your
// real durable write (an INSERT, an S3 putObject, a Kafka produce) and nothing else changes.
class JsonLinesSink implements StateSink {
  /** The NDJSON we have "persisted" so far (inert stand-in for a real store). */
  readonly lines: string[] = []

  constructor(private readonly cursor: Cursor) {}

  async consume(stream: BlockStream, tracking: TrackingContext, options?: ConsumeOptions): Promise<void> {
    // 1) Load the resume position. `undefined` ⇒ nothing processed yet (fresh start).
    const resumeAfter = await this.cursor.load()

    // 2) `withCursor` drops blocks at/below the cursor BEFORE we ever see them, so a restart never
    //    re-processes a block. A batch that becomes empty after filtering is skipped entirely.
    for await (const { data } of withCursor(stream, resumeAfter)) {
      // 3) Decode this batch into rows. `options.run.strict` threads the strict/resilient decode
      //    policy through (same flag the built-in sinks honor); omit `options` and it defaults to
      //    today's resilient behavior.
      const { valueRows } = processBatch(tracking, data, { strict: options?.run.strict })
      for (const row of valueRows) this.lines.push(serialize(row))

      // 4) Advance the cursor ONLY after the durable write above succeeded, so a crash can never
      //    leave the cursor ahead of data we actually persisted.
      const last = data.at(-1)?.header.number
      if (last !== undefined) await this.cursor.save(last)
    }

    // ── Reorg caveat ──
    // A cursor is a high-water mark, NOT a reorg-rollback mechanism. If your sink follows the chain
    // live, a reorg can invalidate already-persisted rows. To stay correct you must, in ONE durable
    // transaction, (a) roll the affected rows back and (b) LOWER the saved cursor to the new
    // common-ancestor height. Otherwise restrict the cursor to bounded backfills / append-only
    // stores where rollback is never required (which is exactly what this offline demo does).
  }
}

/** Serialize one decoded value row to a compact NDJSON line (bigints → strings; null → omitted). */
function serialize(r: ValueRow): string {
  return JSON.stringify({
    variable: r.variable,
    key1: r.key1,
    key2: r.key2,
    value: r.valueNum != null ? r.valueNum.toString() : r.valueHex,
    block: r.blockNumber,
    tx: r.transactionIndex,
  })
}

// ── Build a TrackingContext offline (the builder does this for you when you call `.run()`) ──
// Track DAI's `balanceOf` mapping, keyed off Transfer's `from`/`to` args — the same declaration you
// would write with the fluent builder, just resolved here directly so no network is touched.
const TRANSFER_SIG = 'event Transfer(address indexed from, address indexed to, uint256 value)'
const balanceOf = mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' }).keysFrom(TRANSFER_SIG, [['from'], ['to']])
const tracked = [balanceOf._tracked]
const plans = await resolvePlans(undefined, tracked) // undefined source: inline shapes, no solc
const tracking = buildTrackingContext(CONTRACT, plans, tracked)

// ── An OFFLINE fake batch stream (tests/fixtures.ts style, inlined so the example is self-contained) ──
const ADDR_A = '0xaa11111111111111111111111111111111111111' as Hex
const ADDR_B = '0xbb22222222222222222222222222222222222222' as Hex
// topic0 for Transfer — derived the same way src/events.ts does, so the fake logs match the tracker.
const TRANSFER_TOPIC = toEventSelector(parseAbiItem(TRANSFER_SIG))
const word = (n: bigint): Hex => pad(toHex(n), { size: 32 }) // a 32-byte storage word
const transfer = (from: Hex, to: Hex, value: bigint) => ({
  topics: [TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })] as Hex[],
  data: encodeKey('uint256', value),
})
const balSlot = (holder: Hex) => mappingSlot(2, [encodeKey('address', holder)]) // where balanceOf[holder] lives
const diffAt = (slot: Hex, value: Hex) => ({ transactionIndex: 0, key: slot, kind: '*', next: value })
const blockAt = (number: number, logs: ReturnType<typeof transfer>[], diffs: ReturnType<typeof diffAt>[]): BlockInput => ({
  header: { number, timestamp: 1_700_000_000 },
  logs,
  stateDiffs: diffs,
})

/** A `BlockStream`-shaped async iterable of pre-built batches (a stand-in for the Portal stream). */
async function* fakeStream(...batches: BlockInput[][]): AsyncIterable<{ data: BlockInput[] }> {
  for (const data of batches) yield { data }
}

// Two batches: block 100 sets A→B (B's balance becomes 100), block 101 sends some back
// (B→70, A→30). Both holders are labeled by the Transfer events in the same batches.
const batches: BlockInput[][] = [
  [blockAt(100, [transfer(ADDR_A, ADDR_B, 100n)], [diffAt(balSlot(ADDR_B), word(100n))])],
  [blockAt(101, [transfer(ADDR_B, ADDR_A, 30n)], [diffAt(balSlot(ADDR_B), word(70n)), diffAt(balSlot(ADDR_A), word(30n))])],
]

// ── Pass 1: fresh cursor → consume everything, persist NDJSON, cursor advances to block 101 ──
const cursor = new MemoryCursor()
const sink = new JsonLinesSink(cursor)
await sink.consume(fakeStream(...batches) as BlockStream, tracking)

console.log('Custom JsonLinesSink — pass 1 (fresh start)')
console.log(`  persisted ${sink.lines.length} value row(s) as NDJSON:`)
for (const line of sink.lines) console.log(`    ${line}`)
console.log(`  cursor is now at block ${await cursor.load()}`)

// ── Pass 2: same stream, but the cursor is already at 101 → withCursor skips both batches ──
// This is the resumability guarantee: re-running after a "restart" re-processes nothing.
const sink2 = new JsonLinesSink(cursor)
await sink2.consume(fakeStream(...batches) as BlockStream, tracking)

console.log('\nCustom JsonLinesSink — pass 2 (resume from saved cursor)')
console.log(`  persisted ${sink2.lines.length} new row(s) (expected 0 — all blocks <= cursor were skipped)`)

// ── A small assertion so the example fails loudly if the seam ever regresses ──
if (sink.lines.length !== 3) throw new Error(`expected 3 persisted rows in pass 1, got ${sink.lines.length}`)
if (sink2.lines.length !== 0) throw new Error(`expected 0 persisted rows in pass 2, got ${sink2.lines.length}`)
console.log('\nOK — custom sink persisted rows and resumed from the cursor with no duplicates.')
