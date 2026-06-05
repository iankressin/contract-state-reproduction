/**
 * Public API of `@iankressin/contract-state`.
 *
 * The one obvious way in is the `ContractState` fluent builder + the `scalar`/`mapping`/`derived`
 * track-spec helpers. `PostgresSink`/`MemorySink` (or a custom `StateSink`) decide where rows land;
 * `processBatch` + the row/block types are the seam for writing your own sink; the schema tables +
 * `createTablesSql` are exported for querying Postgres directly.
 */

// ── Authoring (the one obvious way) ──
export { ContractState } from './builder.ts'
export type { ContractStateBuilder } from './builder.ts'
export { derived, mapping, scalar } from './track.ts'
export type { MappingShape, ScalarShape, TrackSpec } from './track.ts'

// ── Sinks ──
export { MemorySink, PostgresSink } from './sink.ts'
export type { BlockStream, StateSink } from './sink.ts'

// ── Custom-sink seam ──
export { processBatch } from './pipeline.ts'
export type {
  BlockInput,
  DiffInput,
  LabelRow,
  LogInput,
  RowBatch,
  StateRow,
  TrackingContext,
  ValueRow,
} from './pipeline.ts'

// ── Schema (for querying Postgres directly) ──
export { allTables, createTablesSql, slotLabel, stateLog, stateValue } from './schema.ts'

// ── Errors (catch a ContractStateError, branch on `.code`) ──
export { ConfigError, ContractStateError, DecodingError, LayoutError, PortalError, SinkError } from './errors.ts'

// ── Run-time behavior (strict/retry/abort, logging, counters) ──
export type { ConsumeOptions } from './sink.ts'
export type { Logger, LogLevel, Stats } from './observability.ts'
export type { RunOptions } from './options.ts'
export type { RetryPolicy } from './resilience.ts'

// ── Shared types ──
export type { SourceConfig, ValueCategory } from './config.ts'
export type { BlockRange } from './query.ts'
