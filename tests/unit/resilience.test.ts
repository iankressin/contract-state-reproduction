import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Logger } from '../../src/observability.ts'
import { newStats } from '../../src/observability.ts'
import { type RetryDeps, type RetryPolicy, defaultIsRetryable, withRetry } from '../../src/resilience.ts'

/** A retryable infra error (caught by defaultIsRetryable). */
function infraError(code = 'ECONNRESET'): Error & { code: string } {
  return Object.assign(new Error(`infra: ${code}`), { code })
}

/** A fatal error (not retryable). */
function fatalError(): Error {
  return new Error('deterministic fault')
}

/**
 * Fixed-rng, recording fake-sleep harness. `rng` is constant so the jittered schedule is
 * deterministic; `sleep` records each requested delay and resolves synchronously (no real timers).
 */
function harness(rngValue = 0.5) {
  const delays: number[] = []
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms)
  })
  const clock = vi.fn(() => 0)
  const rng = () => rngValue
  const policy: RetryPolicy = { sleep, clock, rng }
  return { delays, sleep, clock, policy }
}

describe('withRetry — success paths', () => {
  test('succeeds on the first try with no retries or sleeps', async () => {
    const { policy, sleep } = harness()
    const stats = newStats()
    const fn = vi.fn(async () => 'ok')

    await expect(withRetry(fn, policy, { stats })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(stats.retries).toBe(0)
    expect(stats.retriesExhausted).toBe(0)
  })

  test('retries a retryable error then succeeds', async () => {
    const { policy, sleep } = harness()
    const stats = newStats()
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw infraError()
      return 'ok'
    })

    await expect(withRetry(fn, policy, { stats })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(stats.retries).toBe(2)
    expect(stats.retriesExhausted).toBe(0)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

describe('withRetry — exhaustion', () => {
  test('exhausts maxAttempts on a persistently retryable error and rethrows the ORIGINAL', async () => {
    const { policy } = harness()
    const stats = newStats()
    const errors: Error[] = []
    const fn = vi.fn(async () => {
      const e = infraError()
      errors.push(e)
      throw e
    })

    const caught = await withRetry(fn, { ...policy, maxAttempts: 3 }, { stats }).catch((e) => e)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(stats.retries).toBe(2)
    expect(stats.retriesExhausted).toBe(1)
    // identity: the rethrown error is the LAST original error, not a wrapper
    expect(caught).toBe(errors[errors.length - 1])
  })
})

describe('withRetry — non-retryable', () => {
  test('rethrows immediately with no sleeps and no stat bumps', async () => {
    const { policy, sleep } = harness()
    const stats = newStats()
    const original = fatalError()
    const fn = vi.fn(async () => {
      throw original
    })

    const caught = await withRetry(fn, policy, { stats }).catch((e) => e)
    expect(caught).toBe(original)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(stats.retries).toBe(0)
    expect(stats.retriesExhausted).toBe(0)
  })

  test('respects a custom isRetryable override', async () => {
    const { policy, sleep } = harness()
    const fn = vi.fn(async () => {
      throw fatalError()
    })
    // Force everything retryable, then bound attempts so the test terminates.
    const caught = await withRetry(fn, { ...policy, isRetryable: () => true, maxAttempts: 2 }, {}).catch((e) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})

describe('withRetry — backoff schedule', () => {
  test('exponential with full jitter at a fixed rng (0.5)', async () => {
    const { policy, delays } = harness(0.5)
    const fn = vi.fn(async () => {
      throw infraError()
    })
    // base 250, factor 2, jitter 1, rng 0.5 → caps 250,500,1000,2000 → delays 0.5×cap
    await withRetry(fn, { ...policy, maxAttempts: 5, baseMs: 250, factor: 2, jitter: 1 }, {}).catch(() => {})
    expect(delays).toEqual([125, 250, 500, 1000])
  })

  test('caps each delay at maxMs', async () => {
    const { policy, delays } = harness(0.5)
    const fn = vi.fn(async () => {
      throw infraError()
    })
    // caps min(600, 250×2^n) = 250,500,600,600 → ×0.5
    await withRetry(fn, { ...policy, maxAttempts: 5, baseMs: 250, factor: 2, maxMs: 600, jitter: 1 }, {}).catch(() => {})
    expect(delays).toEqual([125, 250, 300, 300])
  })

  test('jitter 0 yields the deterministic capped delay (no rng influence)', async () => {
    const { policy, delays } = harness(0.99)
    const fn = vi.fn(async () => {
      throw infraError()
    })
    await withRetry(fn, { ...policy, maxAttempts: 4, baseMs: 100, factor: 2, jitter: 0 }, {}).catch(() => {})
    expect(delays).toEqual([100, 200, 400])
  })

  test('jitter > 1 clamps to full jitter (1)', async () => {
    const { policy, delays } = harness(0.5)
    const fn = vi.fn(async () => {
      throw infraError()
    })
    await withRetry(fn, { ...policy, maxAttempts: 2, baseMs: 100, factor: 2, jitter: 2 }, {}).catch(() => {})
    expect(delays).toEqual([50]) // same as jitter 1: 0.5 × 100
  })

  test('jitter < 0 clamps to deterministic (0)', async () => {
    const { policy, delays } = harness(0.99)
    const fn = vi.fn(async () => {
      throw infraError()
    })
    await withRetry(fn, { ...policy, maxAttempts: 2, baseMs: 100, factor: 2, jitter: -5 }, {}).catch(() => {})
    expect(delays).toEqual([100]) // same as jitter 0: the full cap
  })
})

describe('withRetry — logging', () => {
  test('warns once per backoff with { attempt, delay }', async () => {
    const { policy } = harness(0.5)
    const warn = vi.fn()
    const logger = { warn } as unknown as Logger
    const fn = vi.fn(async () => {
      throw infraError()
    })

    await withRetry(fn, { ...policy, maxAttempts: 3, baseMs: 250, factor: 2, jitter: 1 }, { logger }).catch(() => {})
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(1, { attempt: 1, delay: 125 }, 'retryable error; backing off')
    expect(warn).toHaveBeenNthCalledWith(2, { attempt: 2, delay: 250 }, 'retryable error; backing off')
  })
})

describe('withRetry — abort', () => {
  test('an already-aborted signal short-circuits before the first attempt', async () => {
    const { policy, sleep } = harness()
    const fn = vi.fn(async () => 'ok')
    const controller = new AbortController()
    controller.abort()
    const deps: RetryDeps = { signal: controller.signal }

    const caught = await withRetry(fn, policy, deps).catch((e) => e)
    expect((caught as Error).name).toBe('AbortError')
    expect(fn).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  test('a signal aborted between attempts stops further retries', async () => {
    const controller = new AbortController()
    const delays: number[] = []
    // Abort during the first backoff sleep so the next loop iteration short-circuits.
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms)
      controller.abort()
    })
    const policy: RetryPolicy = { sleep, rng: () => 0.5 }
    const fn = vi.fn(async () => {
      throw infraError()
    })

    const caught = await withRetry(fn, policy, { signal: controller.signal }).catch((e) => e)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toHaveLength(1)
    expect((caught as Error).name).toBe('AbortError')
  })
})

describe('withRetry — default (setTimeout-based) sleep', () => {
  // Fake timers exercise the REAL defaultSleep without injecting a sleep and without any real
  // wall-clock time elapsing, so the suite stays deterministic and fast.
  afterEach(() => {
    vi.useRealTimers()
  })

  test('waits the backoff via setTimeout, then resolves and succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 2) throw infraError()
      return 'ok'
    })
    // No injected sleep → uses defaultSleep. rng 0.5, base 100, jitter 1 → first delay 50ms.
    const p = withRetry(fn, { baseMs: 100, factor: 2, jitter: 1, rng: () => 0.5 }, {})
    await vi.advanceTimersByTimeAsync(50)
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('with a (non-aborted) signal present, the timer resolves naturally and the abort listener is removed', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 2) throw infraError()
      return 'ok'
    })
    const p = withRetry(fn, { baseMs: 100, jitter: 0 }, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('rejects the sleep with AbortError when the signal aborts mid-backoff', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fn = vi.fn(async () => {
      throw infraError()
    })
    const p = withRetry(fn, { baseMs: 1000, jitter: 0, rng: () => 0.5 }, { signal: controller.signal })
    const caught = p.catch((e) => e)
    // Flush microtasks so the first attempt rejects and defaultSleep registers its abort listener
    // while the (fake) setTimeout is still pending, THEN abort to fire onAbort (clearTimeout+reject).
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    controller.abort()
    expect((await caught).name).toBe('AbortError')
    // The timer was cleared by onAbort, so advancing past it does not resolve or retry.
    await vi.advanceTimersByTimeAsync(2000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('defaultSleep rejects synchronously when the signal is already aborted at sleep entry', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    // Custom isRetryable aborts the signal the moment the (retryable) error is classified — this runs
    // synchronously just before withRetry calls sleep(), so defaultSleep sees an already-aborted
    // signal at entry and rejects without ever scheduling a timer.
    const fn = vi.fn(async () => {
      throw infraError()
    })
    const isRetryable = (err: unknown) => {
      controller.abort()
      return defaultIsRetryable(err)
    }
    const caught = await withRetry(fn, { baseMs: 1000, jitter: 0, isRetryable }, { signal: controller.signal }).catch((e) => e)
    expect((caught as Error).name).toBe('AbortError')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('defaultIsRetryable', () => {
  const retryable: Array<[string, unknown]> = [
    ['ECONNRESET', infraError('ECONNRESET')],
    ['ECONNREFUSED', infraError('ECONNREFUSED')],
    ['ETIMEDOUT', infraError('ETIMEDOUT')],
    ['EAI_AGAIN', infraError('EAI_AGAIN')],
    ['EPIPE', infraError('EPIPE')],
    ['ENOTFOUND', infraError('ENOTFOUND')],
    ['HTTP 500 (status)', { status: 500 }],
    ['HTTP 503 (statusCode)', { statusCode: 503 }],
    ['HTTP 429', { status: 429 }],
  ]
  const notRetryable: Array<[string, unknown]> = [
    ['AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['HTTP 400', { status: 400 }],
    ['HTTP 404', { statusCode: 404 }],
    ['plain Error', new Error('nope')],
    ['unknown code', infraError('ESOMETHING')],
    ['null', null],
    ['undefined', undefined],
    ['string', 'a string'],
    ['number', 42],
  ]

  for (const [label, err] of retryable) {
    test(`retryable: ${label}`, () => {
      expect(defaultIsRetryable(err)).toBe(true)
    })
  }
  for (const [label, err] of notRetryable) {
    test(`not retryable: ${label}`, () => {
      expect(defaultIsRetryable(err)).toBe(false)
    })
  }
})
