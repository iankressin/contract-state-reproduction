/**
 * Logging + run-time counters for `@iankressin/contract-state`.
 *
 * Phase 0 ships a tiny, dependency-free console-backed {@link Logger}. The {@link Logger}
 * interface is intentionally pino-shaped so a later phase can swap the DEFAULT implementation to
 * pino without changing any call site. {@link Stats} is a flat counter bag threaded through the
 * pipeline; {@link ReorgInfo} is a placeholder consumed by the reorg-handling phase.
 */

/** Severity, ordered least→most severe; `'silent'` disables all output. */
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

/** Numeric rank per level; higher = more severe. Used to gate emission. */
const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 60,
}

/** The five emitting levels, in rank order (excludes `'silent'`). */
type EmitLevel = Exclude<LogLevel, 'silent'>

/** Maps each emitting level to the `console` method it writes through. */
const CONSOLE_METHOD: Record<EmitLevel, (...args: unknown[]) => void> = {
  trace: (...a) => console.debug(...a),
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
}

/**
 * Create a small console-backed {@link Logger}.
 *
 * A call at level `L` emits only when `rank(L) >= rank(configured)` and the configured level is not
 * `'silent'`. Output routes through the matching `console` method: `trace`/`debug` → `console.debug`,
 * `info` → `console.info`, `warn` → `console.warn`, `error` → `console.error`. Both call forms are
 * supported: `(msg)` and `(obj, msg)` — when an object is given it is passed through to `console`
 * ahead of the (optional) message, matching pino's `(mergingObject, message)` shape.
 *
 * @param level Minimum level to emit; defaults to `'info'`.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const configuredRank = LEVEL_RANK[level]

  const emit = (at: EmitLevel, objOrMsg: unknown, msg?: string): void => {
    if (level === 'silent') return
    if (LEVEL_RANK[at] < configuredRank) return
    const write = CONSOLE_METHOD[at]
    if (msg === undefined) write(objOrMsg)
    else write(objOrMsg, msg)
  }

  return {
    level,
    trace: (objOrMsg: unknown, msg?: string) => emit('trace', objOrMsg, msg),
    debug: (objOrMsg: unknown, msg?: string) => emit('debug', objOrMsg, msg),
    info: (objOrMsg: unknown, msg?: string) => emit('info', objOrMsg, msg),
    warn: (objOrMsg: unknown, msg?: string) => emit('warn', objOrMsg, msg),
    error: (objOrMsg: unknown, msg?: string) => emit('error', objOrMsg, msg),
  }
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
}

/** Create a fresh {@link Stats} with all counters at zero. */
export function newStats(): Stats {
  return { droppedLogs: 0, retries: 0, retriesExhausted: 0 }
}

/**
 * Description of a detected chain reorganization. Placeholder for the reorg-handling phase;
 * defined now so the {@link Logger}/options surface is write-once.
 */
export interface ReorgInfo {
  /** Block height the chain rolled back from. */
  from: number
  /** Block height the chain rolled back to (the new common ancestor). */
  to: number
  /** Number of blocks rolled back (`from - to`). */
  depth: number
}
