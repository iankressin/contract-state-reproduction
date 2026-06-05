/**
 * The seam between producing decoded batches and persisting them.
 *
 *  - PostgresSink: drives the SDK Drizzle target (reorg snapshots + cursor + transactions),
 *    creates tables from the schema's single-source DDL, and inserts each batch.
 *  - MemorySink: collects RowBatches in memory (no reorg) — for tests and bounded backfills,
 *    and works with any async-iterable of `{ data }` (the real stream or a fixture stream).
 *
 * `drizzle-orm` is a single deduped install shared with `@subsquid/pipes` (it declares drizzle-orm
 * as a peer), so our db/tables/tx and the SDK's Drizzle target share one type identity — no casts
 * needed at the boundary.
 */
import { batchForInsert, drizzleTarget } from '@subsquid/pipes/targets/drizzle/node-postgres'
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres'
import { ContractStateError, SinkError } from './errors.ts'
import { type Logger, type Stats, defaultLogger, makeDispatch, newStats } from './observability.ts'
import type { RunOptions } from './options.ts'
import { type BlockInput, type LabelRow, type RowBatch, type TrackingContext, processBatch } from './pipeline.ts'
import { withRetry } from './resilience.ts'
import { allTables, createTablesSql, slotLabel, stateLog, stateValue } from './schema.ts'

/** Range + produced-row count for one processed batch, derived from its block headers. */
type BatchProgress = { from: number; to: number; rows: number }

/**
 * Compute `{ from, to, rows }` for a processed batch: `from`/`to` are the first/last block heights in
 * `data`, `rows` is the decoded value-row count. Returns `undefined` for an empty batch (no headers).
 */
function batchProgress(data: BlockInput[], valueRowCount: number): BatchProgress | undefined {
  const first = data[0]
  const last = data.at(-1)
  if (!first || !last) return undefined
  return { from: first.header.number, to: last.header.number, rows: valueRowCount }
}

/** A stream of decoded block batches: any async-iterable yielding `{ data }`. */
export type BlockStream = AsyncIterable<{ data: BlockInput[] }> & { pipeTo?: (target: unknown) => Promise<void> }

/** Ambient run context a sink threads into the transform: the run options, where to log, what to count. */
export interface ConsumeOptions {
  run: RunOptions
  logger: Logger
  stats: Stats
}

export interface StateSink {
  consume(stream: BlockStream, tracking: TrackingContext, options?: ConsumeOptions): Promise<void>
}

export class PostgresSink implements StateSink {
  constructor(private readonly db: NodePgDatabase) {}

  /** Build the node-postgres Drizzle handle internally — callers never import drizzle-orm. */
  static fromConnectionString(url: string): PostgresSink {
    return new PostgresSink(drizzle(url))
  }

  async consume(stream: BlockStream, tracking: TrackingContext, options?: ConsumeOptions): Promise<void> {
    const { run, logger, stats } = options ?? { run: {}, logger: defaultLogger, stats: newStats() }
    const dispatch = makeDispatch(run, stats, logger)
    // Highest block height we have processed so far — the best-effort `from` for a reorg's depth, since
    // the SDK's rollback callback only hands us the new common-ancestor (`to`), not the pre-fork head.
    let lastProcessedBlock: number | undefined

    const target = drizzleTarget<BlockInput[]>({
      db: this.db,
      tables: allTables,
      onStart: async ({ db }) => {
        await db.execute(createTablesSql())
        // Persist scalar/struct-field slot labels (fixed, known up-front). Parameterized via the same
        // Drizzle insert path as onData so a variable name with quotes/special chars can't break or
        // inject the statement.
        const labels: LabelRow[] = [...tracking.scalarSlots].flatMap(([slot, fields]) =>
          fields.map((f) => ({ contract: tracking.contract, slot, variable: f.variable, key1: '', key2: '' })),
        )
        for (const c of batchForInsert(labels)) await db.insert(slotLabel).values(c).onConflictDoNothing()
      },
      onData: async ({ tx, data }) => {
        // Stop at the batch boundary if the caller aborted: throwIfAborted() raises an AbortError that
        // propagates out of pipeTo; withRetry treats AbortError as fatal (no retry) and the consume
        // catch below recognizes it and resolves cleanly with whatever was already committed.
        run.signal?.throwIfAborted()
        const { stateRows, labelRows, valueRows } = processBatch(tracking, data, { strict: run.strict, logger, stats })
        for (const c of batchForInsert(labelRows)) await tx.insert(slotLabel).values(c).onConflictDoNothing()
        for (const c of batchForInsert(stateRows)) await tx.insert(stateLog).values(c).onConflictDoNothing()
        for (const c of batchForInsert(valueRows)) await tx.insert(stateValue).values(c).onConflictDoNothing()
        const p = batchProgress(data, valueRows.length)
        if (p) {
          lastProcessedBlock = lastProcessedBlock === undefined ? p.to : Math.max(lastProcessedBlock, p.to)
          dispatch.progress(p)
        }
      },
      // The Drizzle target fires this AFTER it has rolled the snapshot back to the new common ancestor
      // `cursor` (a BlockCursor — only `.number` is meaningful here). `to` is authoritative; `from`
      // is best-effort (the highest block we'd processed) and `depth = from - to`.
      onAfterRollback: ({ cursor }) => {
        const to = cursor.number
        const from = lastProcessedBlock !== undefined && lastProcessedBlock > to ? lastProcessedBlock : to
        dispatch.reorg({ from, to, depth: from - to })
        lastProcessedBlock = to
      },
    })

    if (!stream.pipeTo) throw new SinkError('PostgresSink needs the Portal stream (no pipeTo on this stream)', 'SINK_NO_PIPETO')
    // Retry transient infra failures (socket drops, 5xx/429) with backoff; config/decode/abort faults
    // are non-retryable (default-deny in withRetry) and stay fatal. A non-typed infra failure at the
    // boundary is translated into a SinkError so callers always catch a ContractStateError.
    try {
      await withRetry(() => stream.pipeTo!(target), run.retry, { logger, stats, signal: run.signal })
    } catch (e) {
      // An abort resolves CLEANLY (partial results already committed): the consume promise fulfils,
      // it does not reject. Only genuinely-unknown failures become a SinkError; typed library errors
      // pass through unchanged so callers branch on `.code`.
      if (isAbort(e)) return
      if (e instanceof ContractStateError) throw e
      dispatch.error(e)
      throw new SinkError('Postgres sink failed while consuming the stream', 'SINK_CONSUME_FAILED', { cause: e })
    }
  }
}

/** True for a DOM-style `AbortError` (what `AbortSignal.throwIfAborted()` / the abortable sleep raise). */
function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

export class MemorySink implements StateSink {
  readonly batches: RowBatch[] = []

  // MemorySink is bounded/offline and accumulates batches in memory; it deliberately does NOT retry
  // (a restart would re-consume the stream and duplicate the already-collected batches). It only
  // threads the decode policy + logger/stats into the transform and fires progress per batch.
  async consume(stream: BlockStream, tracking: TrackingContext, options?: ConsumeOptions): Promise<void> {
    const { run, logger, stats } = options ?? { run: {}, logger: defaultLogger, stats: newStats() }
    const dispatch = makeDispatch(run, stats, logger)
    for await (const { data } of stream) {
      // Cancel at the batch boundary: if the caller aborted, stop BEFORE processing this batch and
      // return normally — the run/collect resolves cleanly with the batches already collected.
      if (run.signal?.aborted) break
      const batch = processBatch(tracking, data, { strict: run.strict, logger, stats })
      this.batches.push(batch)
      const p = batchProgress(data, batch.valueRows.length)
      if (p) dispatch.progress(p)
    }
  }

  /** All collected rows, flattened across batches. */
  get rows(): RowBatch {
    return {
      stateRows: this.batches.flatMap((b) => b.stateRows),
      labelRows: this.batches.flatMap((b) => b.labelRows),
      valueRows: this.batches.flatMap((b) => b.valueRows),
    }
  }
}
