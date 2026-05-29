/**
 * The seam between producing decoded batches and persisting them.
 *
 *  - PostgresSink: drives the SDK Drizzle target (reorg snapshots + cursor + transactions),
 *    creates tables from the schema's single-source DDL, and inserts each batch.
 *  - MemorySink: collects RowBatches in memory (no reorg) — for tests and bounded backfills,
 *    and works with any async-iterable of `{ data }` (the real stream or a fixture stream).
 *
 * NOTE on the `any` casts: `@subsquid/pipes` is linked from a sibling repo, so the drizzle-orm
 * backing its types is a physically different install than ours (same version). drizzle keys
 * tables/columns by global Symbol.for and only our own db/tables/tx cross the boundary, so this
 * is correct at runtime — the casts only drop the cross-install type identity.
 */
import { batchForInsert, drizzleTarget } from '@subsquid/pipes/targets/drizzle/node-postgres'
import type { drizzle } from 'drizzle-orm/node-postgres'
import { type BlockInput, type RowBatch, type TrackingContext, processBatch } from './pipeline.ts'
import { allTables, createTablesSql, slotLabel, stateLog, stateValue } from './schema.ts'

/** A stream of decoded block batches: any async-iterable yielding `{ data }`. */
export type BlockStream = AsyncIterable<{ data: BlockInput[] }> & { pipeTo?: (target: unknown) => Promise<void> }

export interface StateSink {
  consume(stream: BlockStream, tracking: TrackingContext): Promise<void>
}

export class PostgresSink implements StateSink {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async consume(stream: BlockStream, tracking: TrackingContext): Promise<void> {
    await (stream as { pipeTo: (t: unknown) => Promise<void> }).pipeTo(
      drizzleTarget<BlockInput[]>({
        db: this.db as any,
        tables: allTables as any,
        onStart: async ({ db }: { db: any }) => {
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
        onData: async ({ tx, data }: { tx: any; data: BlockInput[] }) => {
          const { stateRows, labelRows, valueRows } = processBatch(tracking, data)
          for (const c of batchForInsert(labelRows)) await tx.insert(slotLabel).values(c).onConflictDoNothing()
          for (const c of batchForInsert(stateRows)) await tx.insert(stateLog).values(c).onConflictDoNothing()
          for (const c of batchForInsert(valueRows)) await tx.insert(stateValue).values(c).onConflictDoNothing()
        },
      }) as any,
    )
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
