/**
 * A tiny, storage-agnostic resume-cursor helper for CUSTOM {@link './sink.ts'.StateSink}
 * implementations.
 *
 * Why this exists: the built-in `PostgresSink` delegates resume/rollback to the SDK's Drizzle
 * target (it persists the last fully-processed block and replays from there after a restart), and
 * `MemorySink` is bounded/offline so it needs none. But anyone writing their OWN sink (e.g. into
 * S3, Kafka, SQLite, a REST API) has to persist a resume position themselves to avoid re-processing
 * blocks after a crash/restart. This module captures that one idea — "load where I left off; save
 * after each batch" — behind a tiny interface, plus an in-memory implementation for tests and
 * ephemeral sinks, and an optional stream filter that skips already-processed blocks.
 *
 * The cursor stores ONE number: the height of the last block that was *fully persisted*. On restart
 * a sink loads it and resumes from `cursor + 1`. It is deliberately NOT coupled to Postgres,
 * Drizzle, or any schema — back it with whatever durable store your sink already uses.
 *
 * Reorg note: a cursor is a high-water mark, not a reorg-rollback mechanism. If your custom sink
 * follows the chain live and must survive reorgs, roll affected rows back AND lower the saved cursor
 * to the new common-ancestor height in the same durable transaction; otherwise restrict the cursor
 * to bounded backfills / append-only stores where rollback isn't required.
 *
 * @example A custom sink that resumes from a persisted cursor and saves after each batch.
 * ```ts
 * import { type Cursor, withCursor } from '@iankressin/contract-state'
 * import { type BlockStream, type ConsumeOptions, type StateSink } from '@iankressin/contract-state'
 * import { type TrackingContext, processBatch } from '@iankressin/contract-state'
 *
 * class MySink implements StateSink {
 *   constructor(private readonly cursor: Cursor) {}
 *
 *   async consume(stream: BlockStream, tracking: TrackingContext, options?: ConsumeOptions) {
 *     // 1) On start, learn where we left off (undefined ⇒ nothing processed yet).
 *     const resumeAfter = await this.cursor.load()
 *
 *     // 2) Skip blocks at/below the cursor, then persist + advance the cursor per batch.
 *     for await (const { data } of withCursor(stream, resumeAfter)) {
 *       const rows = processBatch(tracking, data, { strict: options?.run.strict })
 *       await this.persist(rows)                       // your durable write
 *       const last = data.at(-1)?.header.number
 *       if (last !== undefined) await this.cursor.save(last)  // advance only after a durable write
 *     }
 *   }
 *
 *   private async persist(_rows: unknown) {  ... }
 * }
 * ```
 */
import type { BlockInput } from './pipeline.ts'
import type { BlockStream } from './sink.ts'

/**
 * A durable resume position for a custom sink: the height of the last fully-persisted block.
 *
 * Implementations back this with whatever store the sink already uses (a row in a DB, a key in a
 * KV, a file). {@link save} must only be called AFTER the corresponding batch is durably written,
 * so a crash never advances the cursor past data that wasn't persisted.
 */
export interface Cursor {
  /**
   * Load the last fully-processed block height.
   *
   * @returns The saved height, or `undefined` if nothing has been processed yet (fresh start).
   */
  load(): Promise<number | undefined>
  /**
   * Persist a new high-water mark. Call only after the batch up to and including `block` is durably
   * written. Should be monotonic in practice (each call ≥ the last saved height) except when
   * intentionally lowered to roll back a reorg.
   *
   * @param block The height of the last block fully persisted in the just-completed batch.
   */
  save(block: number): Promise<void>
}

/**
 * In-memory {@link Cursor} for tests and ephemeral sinks.
 *
 * Holds the position in a field — nothing is persisted across process restarts, so this provides NO
 * crash recovery; it exists to exercise cursor-aware sink logic and to back short-lived/offline
 * sinks. For real durability, implement {@link Cursor} against your store.
 */
export class MemoryCursor implements Cursor {
  private _block: number | undefined

  /**
   * @param initial Optional starting height (e.g. seeded from a prior run); defaults to "unset".
   */
  constructor(initial?: number) {
    this._block = initial
  }

  /** @returns The in-memory height, or `undefined` if never saved. */
  async load(): Promise<number | undefined> {
    return this._block
  }

  /** Overwrite the in-memory height. */
  async save(block: number): Promise<void> {
    this._block = block
  }
}

/**
 * Wrap a block-batch stream so it skips blocks already covered by a resume position.
 *
 * Given `resumeAfter` (the last fully-processed height, typically from `await cursor.load()`), each
 * yielded batch is filtered to blocks with `header.number > resumeAfter`; a batch that becomes empty
 * after filtering is dropped entirely (so the sink never sees an empty `data`). When `resumeAfter`
 * is `undefined` (fresh start) every batch passes through unchanged. The relative order of blocks
 * and batches is preserved.
 *
 * This is a pure stream transform — it does NOT read or write the cursor itself; the sink saves the
 * cursor after persisting each batch (see the module example). Pairing the two means a restart
 * resumes exactly at `cursor + 1` with no duplicate processing.
 *
 * @param stream The upstream block-batch stream (`AsyncIterable<{ data: BlockInput[] }>`).
 * @param resumeAfter The last fully-processed height to skip past, or `undefined` to pass all blocks.
 * @returns An async-iterable of `{ data }` batches with already-processed blocks removed.
 */
export async function* withCursor(stream: BlockStream, resumeAfter: number | undefined): AsyncIterable<{ data: BlockInput[] }> {
  for await (const { data } of stream) {
    if (resumeAfter === undefined) {
      yield { data }
      continue
    }
    const fresh = data.filter((b) => b.header.number > resumeAfter)
    if (fresh.length > 0) yield { data: fresh }
  }
}
