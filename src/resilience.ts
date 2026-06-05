/**
 * Retry-with-backoff for transient infrastructure failures.
 *
 * {@link withRetry} wraps an async operation and retries it on transient errors using capped
 * exponential backoff with full jitter. Classification is deliberately conservative
 * (default-deny): only well-known network errors and 5xx/429 HTTP statuses are retried — see
 * {@link defaultIsRetryable}. On a non-retryable error, or after attempts are exhausted, the
 * ORIGINAL error is rethrown unchanged; the call site is responsible for wrapping it into the
 * appropriate {@link './errors.ts'} type (this module never imports `errors.ts`, so config /
 * layout / decoding faults stay fatal by simply not being classified as retryable).
 *
 * All sources of non-determinism — the clock, the sleep, and the jitter RNG — are injectable, so
 * the behavior is fully reproducible under test without real timers.
 */
import type { Logger, Stats } from './observability.ts'

/** Tunable retry behavior. Every field is optional; omitted fields fall back to {@link defaultRetryPolicy}. */
export interface RetryPolicy {
  /** Total tries including the first. Default `5`. */
  maxAttempts?: number
  /** Backoff for the first retry, in ms. Default `250`. */
  baseMs?: number
  /** Upper bound on any single backoff, in ms. Default `30_000`. */
  maxMs?: number
  /** Exponential base. Default `2`. */
  factor?: number
  /** Full-jitter fraction in `[0, 1]`: `0` = deterministic delay, `1` = full jitter. Default `1`. */
  jitter?: number
  /** Override the transient/fatal classification. Default {@link defaultIsRetryable}. */
  isRetryable?: (err: unknown) => boolean
  /** Injected monotonic-ish clock. Default {@link Date.now}. */
  clock?: () => number
  /** Injected, abortable sleep. Default a `setTimeout`-based sleep that rejects on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injected RNG returning `[0, 1)`, used only for jitter. Default {@link Math.random}. */
  rng?: () => number
}

/** Ambient dependencies for a retry run: where to log, what to count, and an abort signal. */
export interface RetryDeps {
  /** Logger for backoff notices. Optional. */
  logger?: Logger
  /** Counters to increment (`retries`, `retriesExhausted`). Optional. */
  stats?: Stats
  /** Abort signal; when aborted, no further retries are attempted. */
  signal?: AbortSignal
}

/** Built-in defaults for the numeric knobs of {@link RetryPolicy}. */
export const defaultRetryPolicy: Required<Pick<RetryPolicy, 'maxAttempts' | 'baseMs' | 'maxMs' | 'factor' | 'jitter'>> = {
  maxAttempts: 5,
  baseMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 1,
}

/** Transient infra error `code`s (Node/libuv socket + DNS failures) that warrant a retry. */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'])

/** Read a numeric HTTP status from either `status` or `statusCode`, if present. */
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { status?: unknown; statusCode?: unknown }
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode
  return undefined
}

/**
 * Default transient/fatal classifier — conservative (default-deny).
 *
 * Returns `false` for an `AbortError` (deterministic cancellation) and for anything not recognized
 * as transient. Returns `true` for known infra error codes
 * (`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EAI_AGAIN`/`EPIPE`/`ENOTFOUND`) and for HTTP statuses
 * `>= 500` or `=== 429`. Library errors (config/layout/decoding) carry none of these signals, so
 * they are correctly treated as fatal.
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: unknown; code?: unknown }
    if (e.name === 'AbortError') return false
    if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return true
  }
  const status = httpStatusOf(err)
  if (status !== undefined && (status >= 500 || status === 429)) return true
  return false
}

/** Real, abortable sleep used when the caller does not inject one. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Construct a DOM-style `AbortError` (matched by {@link defaultIsRetryable} as fatal). */
function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/**
 * Compute the backoff for a given attempt: capped exponential, then full jitter.
 *
 * Cap = `min(maxMs, baseMs * factor^(attempt-1))`. The returned delay blends a deterministic floor
 * with a jittered remainder: `cap * (1 - jitter) + rng() * cap * jitter`. With `jitter = 1` this is
 * pure full jitter (`rng() * cap`); with `jitter = 0` it is exactly `cap`.
 *
 * @param attempt 1-indexed retry number (the delay BEFORE attempt N+1 uses `attempt = N`).
 */
function backoffDelay(attempt: number, baseMs: number, maxMs: number, factor: number, jitter: number, rng: () => number): number {
  const cap = Math.min(maxMs, baseMs * factor ** (attempt - 1))
  const clampedJitter = jitter < 0 ? 0 : jitter > 1 ? 1 : jitter
  return cap * (1 - clampedJitter) + rng() * cap * clampedJitter
}

/**
 * Run `fn`, retrying transient failures with capped exponential backoff and full jitter.
 *
 * Success returns immediately. On error: if not retryable (per `policy.isRetryable ??`
 * {@link defaultIsRetryable}) the original error is rethrown as-is. If retryable and attempts
 * remain, increments `stats.retries`, logs a `warn`, sleeps the computed backoff, and tries again.
 * When attempts are exhausted, increments `stats.retriesExhausted` and rethrows the LAST original
 * error. An already-aborted `deps.signal` short-circuits before any further attempt.
 *
 * @typeParam T Resolved value of `fn`.
 * @param fn The operation to run; invoked once per attempt.
 * @param policy Retry tuning; see {@link RetryPolicy}.
 * @param deps Ambient logger/stats/abort signal.
 */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = {}, deps: RetryDeps = {}): Promise<T> {
  const maxAttempts = policy.maxAttempts ?? defaultRetryPolicy.maxAttempts
  const baseMs = policy.baseMs ?? defaultRetryPolicy.baseMs
  const maxMs = policy.maxMs ?? defaultRetryPolicy.maxMs
  const factor = policy.factor ?? defaultRetryPolicy.factor
  const jitter = policy.jitter ?? defaultRetryPolicy.jitter
  const isRetryable = policy.isRetryable ?? defaultIsRetryable
  const sleep = policy.sleep ?? defaultSleep
  const rng = policy.rng ?? Math.random
  const { logger, stats, signal } = deps

  let attempt = 0
  while (true) {
    if (signal?.aborted) throw abortError()
    attempt++
    try {
      return await fn()
    } catch (err) {
      const retryable = isRetryable(err)
      const lastAttempt = attempt >= maxAttempts
      if (!retryable || lastAttempt) {
        if (lastAttempt && retryable && stats) stats.retriesExhausted++
        throw err
      }
      if (stats) stats.retries++
      const delay = backoffDelay(attempt, baseMs, maxMs, factor, jitter, rng)
      logger?.warn({ attempt, delay }, 'retryable error; backing off')
      await sleep(delay, signal)
    }
  }
}
