/**
 * Options bag for the terminal pipeline operations (`.run()` / `.collect()`).
 *
 * Every field is optional and the defaults preserve today's resilient behavior, so passing nothing
 * is equivalent to the current implicit configuration. Types-only module: no runtime.
 */
import type { Logger, ReorgInfo } from './observability.ts'
import type { RetryPolicy } from './resilience.ts'

/** Options for `.run()` / `.collect()`. All optional; defaults preserve today's resilient behavior. */
export interface RunOptions {
  /** When `true`, a data anomaly throws a `DecodingError`; when `false` (default) it is warned + counted. */
  strict?: boolean
  /** Retry tuning for transient infra failures. See {@link RetryPolicy}. */
  retry?: RetryPolicy
  /** Abort signal to cancel an in-flight run. */
  signal?: AbortSignal
  /** Logger override; defaults to the library's default logger. */
  logger?: Logger
  /** Progress callback, invoked per processed range with the rows produced. */
  onProgress?: (p: { from: number; to: number; rows: number }) => void
  /** Error callback, invoked with each error encountered (whether or not it is rethrown). */
  onError?: (err: unknown) => void
  /** Reorg callback, invoked when a chain reorganization is detected. */
  onReorg?: (info: ReorgInfo) => void
}
