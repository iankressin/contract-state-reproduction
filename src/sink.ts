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
import { type BlockInput, type RowBatch, type TrackingContext, processBatch } from './pipeline.ts'
import { allTables, createTablesSql, slotLabel, stateLog, stateValue } from './schema.ts'

/** A stream of decoded block batches: any async-iterable yielding `{ data }`. */
export type BlockStream = AsyncIterable<{ data: BlockInput[] }> & { pipeTo?: (target: unknown) => Promise<void> }

export interface StateSink {
  consume(stream: BlockStream, tracking: TrackingContext): Promise<void>
}

export class PostgresSink implements StateSink {
  constructor(private readonly db: NodePgDatabase) {}

  /** Build the node-postgres Drizzle handle internally — callers never import drizzle-orm. */
  static fromConnectionString(url: string): PostgresSink {
    return new PostgresSink(drizzle(url))
  }

  async consume(stream: BlockStream, tracking: TrackingContext): Promise<void> {
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
        const { stateRows, labelRows, valueRows } = processBatch(tracking, data)
        for (const c of batchForInsert(labelRows)) await tx.insert(slotLabel).values(c).onConflictDoNothing()
        for (const c of batchForInsert(stateRows)) await tx.insert(stateLog).values(c).onConflictDoNothing()
        for (const c of batchForInsert(valueRows)) await tx.insert(stateValue).values(c).onConflictDoNothing()
      },
    })

    if (!stream.pipeTo) throw new Error('PostgresSink needs the Portal stream (no pipeTo on this stream)')
    await stream.pipeTo(target)
  }
}

export class MemorySink implements StateSink {
  readonly batches: RowBatch[] = []

  async consume(stream: BlockStream, tracking: TrackingContext): Promise<void> {
    for await (const { data } of stream) this.batches.push(processBatch(tracking, data))
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
