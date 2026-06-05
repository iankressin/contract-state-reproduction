/**
 * Logging + run-time counters for `@iankressin/contract-state`.
 *
 * The default {@link Logger} is backed by **pino**: the {@link Logger} interface was authored
 * pino-shaped (`.level`, `.trace/.debug/.info/.warn/.error` accept `(obj, msg?)` or `(msg)`, and
 * `'silent'` is a valid level), so swapping the implementation to pino changed no call site. pino is
 * injectable (a destination stream can be passed for deterministic capture in tests) and silenceable
 * (`createLogger('silent')` emits nothing). {@link Stats} is a flat counter bag threaded through the
 * pipeline; {@link makeDispatch} turns batch outcomes into Stats bumps + user {@link RunOptions}
 * callbacks; {@link ReorgInfo} describes a detected reorg.
 */
import pino from 'pino'
import type { RunOptions } from './options.ts'

/** Severity, ordered least→most severe; `'silent'` disables all output. Each value is a valid pino level. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'

/**
 * Structured logger, pino-shaped. Each method accepts either a bare message, or a structured
 * object plus an optional message: `log.info('hi')` or `log.info({ block: 42 }, 'synced')`.
 */
export interface Logger {
  /** Configured minimum level; calls below it are dropped. */
  level: LogLevel
  trace(obj: unknown, msg?: string): void
  trace(msg: string): void
  debug(obj: unknown, msg?: string): void
  debug(msg: string): void
  info(obj: unknown, msg?: string): void
  info(msg: string): void
  warn(obj: unknown, msg?: string): void
  warn(msg: string): void
  error(obj: unknown, msg?: string): void
  error(msg: string): void
}

/**
 * Create a pino-backed {@link Logger}.
 *
 * pino already satisfies the {@link Logger} interface: its instance exposes a settable `.level`, its
 * level methods accept both `(mergingObject, message)` and `(message)`, and `'silent'` disables all
 * output. A call at level `L` emits only when `rank(L) >= rank(configured)`; `'silent'` drops
 * everything. Both call forms are supported.
 *
 * @param level Minimum level to emit; defaults to `'info'`.
 * @param destination Optional pino destination stream (anything with `write(chunk: string)`), used
 *   to capture output deterministically in tests. Omit for pino's default (stdout). Additive,
 *   testability-only parameter — the interface and `level` semantics are unchanged.
 */
export function createLogger(level: LogLevel = 'info', destination?: { write(msg: string): void }): Logger {
  // pino's second arg is an optional destination stream; passing one lets tests collect chunks
  // without touching real stdout. The returned instance structurally IS a Logger (the interface was
  // authored pino-shaped); the only type gap is pino typing `.level` as the WIDER
  // LevelWithSilentOrString. Since we only ever pass a LogLevel in, the runtime `.level` is always a
  // LogLevel — narrow it back via a single boundary cast.
  const instance = destination ? pino({ level }, destination) : pino({ level })
  return instance as unknown as Logger
}

/** Process-wide default logger at `'info'`. */
export const defaultLogger: Logger = createLogger('info')

/** Run-time counters threaded through the pipeline. */
export interface Stats {
  /** Number of decoded rows dropped because of a (non-strict) data anomaly. */
  droppedLogs: number
  /** Number of retry attempts performed (does not count the first try). */
  retries: number
  /** Number of operations that exhausted all retry attempts and ultimately failed. */
  retriesExhausted: number
  /** Number of blocks whose batches were processed (sum of `to - from + 1` per progress event). */
  blocks: number
  /** Number of decoded value rows produced across all processed batches. */
  rows: number
  /** Number of chain reorganizations observed. */
  reorgs: number
}

/** Create a fresh {@link Stats} with all counters at zero. */
export function newStats(): Stats {
  return { droppedLogs: 0, retries: 0, retriesExhausted: 0, blocks: 0, rows: 0, reorgs: 0 }
}

/**
 * Description of a detected chain reorganization.
 *
 * `to` is the new common-ancestor height the chain rolled back to (authoritative). `from` and
 * `depth` are best-effort: `from` is the highest block the run had processed before the fork and
 * `depth` is `from - to`. When the pre-fork height is unknown they collapse to `to`/`0`.
 */
export interface ReorgInfo {
  /** Block height the chain rolled back from (best-effort: highest processed before the fork). */
  from: number
  /** Block height the chain rolled back to (the new common ancestor; authoritative). */
  to: number
  /** Number of blocks rolled back (`from - to`; best-effort, `0` when `from` is unknown). */
  depth: number
}

/**
 * Bundle of dispatchers that fan a batch outcome out to {@link Stats} counters AND the user's
 * {@link RunOptions} lifecycle callbacks. One place owns "bump the counter, then call the hook", so
 * sinks stay thin and Stats can never drift from what the callbacks report.
 */
export interface Dispatch {
  /**
   * Record a processed range: add `to - from + 1` to `stats.blocks`, add `rows` to `stats.rows`,
   * then invoke `run.onProgress` (if provided) with the same payload.
   */
  progress(p: { from: number; to: number; rows: number }): void
  /** Forward an error to `run.onError` (if provided). Does not throw; never swallows the error itself. */
  error(err: unknown): void
  /** Record a reorg: increment `stats.reorgs`, then invoke `run.onReorg` (if provided) with `info`. */
  reorg(info: ReorgInfo): void
}

/**
 * Build the {@link Dispatch} bundle that wires a sink's per-batch outcomes into {@link Stats} and the
 * caller's {@link RunOptions} callbacks. Pure factory: it captures `run`/`stats`/`logger` and returns
 * closures; it performs no I/O of its own beyond invoking the (optional) user callbacks.
 *
 * @param run The run options carrying the optional `onProgress`/`onError`/`onReorg` callbacks.
 * @param stats The counter bag to bump (mutated in place).
 * @param _logger The run logger (reserved for future dispatch-level logging; unused today).
 */
export function makeDispatch(run: RunOptions, stats: Stats, _logger: Logger): Dispatch {
  return {
    progress: (p) => {
      stats.blocks += p.to - p.from + 1
      stats.rows += p.rows
      run.onProgress?.(p)
    },
    error: (err) => {
      run.onError?.(err)
    },
    reorg: (info) => {
      stats.reorgs++
      run.onReorg?.(info)
    },
  }
}
