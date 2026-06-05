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
import { type Logger, type Stats, defaultLogger, newStats } from './observability.ts'
import type { RunOptions } from './options.ts'
import { type BlockInput, type RowBatch, type TrackingContext, processBatch } from './pipeline.ts'
import { withRetry } from './resilience.ts'
import { allTables, createTablesSql, slotLabel, stateLog, stateValue } from './schema.ts'

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

    const target = drizzleTarget<BlockInput[]>({
      db: this.db,
      tables: allTables,
      onStart: async ({ db }) => {
        await db.execute(createTablesSql())
        // Persist scalar/struct-field slot labels (fixed, known up-front).
        for (const [slot, fields] of tracking.scalarSlots) {
          for (const f of fields) {
            await db.execute(
              `INSERT INTO slot_label (contract, slot, variable) VALUES ('${tracking.contract}', '${slot}', '${f.variable}') ON CONFLICT DO NOTHING`,
            )
          }
        }
      },
      onData: async ({ tx, data }) => {
        const { stateRows, labelRows, valueRows } = processBatch(tracking, data, { strict: run.strict, logger, stats })
        for (const c of batchForInsert(labelRows)) await tx.insert(slotLabel).values(c).onConflictDoNothing()
        for (const c of batchForInsert(stateRows)) await tx.insert(stateLog).values(c).onConflictDoNothing()
        for (const c of batchForInsert(valueRows)) await tx.insert(stateValue).values(c).onConflictDoNothing()
      },
    })

    if (!stream.pipeTo) throw new SinkError('PostgresSink needs the Portal stream (no pipeTo on this stream)', 'SINK_NO_PIPETO')
    // Retry transient infra failures (socket drops, 5xx/429) with backoff; config/decode/abort faults
    // are non-retryable (default-deny in withRetry) and stay fatal. A non-typed infra failure at the
    // boundary is translated into a SinkError so callers always catch a ContractStateError.
    try {
      await withRetry(() => stream.pipeTo!(target), run.retry, { logger, stats, signal: run.signal })
    } catch (e) {
      if (e instanceof ContractStateError) throw e
      throw new SinkError('Postgres sink failed while consuming the stream', 'SINK_CONSUME_FAILED', { cause: e })
    }
  }
}

export class MemorySink implements StateSink {
  readonly batches: RowBatch[] = []

  // MemorySink is bounded/offline and accumulates batches in memory; it deliberately does NOT retry
  // (a restart would re-consume the stream and duplicate the already-collected batches). It only
  // threads the decode policy + logger/stats into the transform.
  async consume(stream: BlockStream, tracking: TrackingContext, options?: ConsumeOptions): Promise<void> {
    const { run, logger, stats } = options ?? { run: {}, logger: defaultLogger, stats: newStats() }
    for await (const { data } of stream) this.batches.push(processBatch(tracking, data, { strict: run.strict, logger, stats }))
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
