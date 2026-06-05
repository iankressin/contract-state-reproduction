import { describe, expect, test, vi } from 'vitest'
import { createLogger, defaultLogger, type Logger, makeDispatch, newStats, type ReorgInfo, type Stats } from '../../src/observability.ts'
import type { RunOptions } from '../../src/options.ts'

/**
 * A pino destination that collects every written chunk, so we can assert on emitted records WITHOUT
 * touching real stdout. pino writes one newline-terminated JSON object per log call; `records()`
 * parses them back into objects.
 */
function capture() {
  const chunks: string[] = []
  return {
    stream: { write: (s: string) => chunks.push(s) },
    /** Parsed log records, one per emitted line. */
    records: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
    /** Number of emitted records. */
    count: () => chunks.length,
  }
}

describe('newStats', () => {
  test('returns all-zero counters (incl. the appended blocks/rows/reorgs)', () => {
    expect(newStats()).toEqual({ droppedLogs: 0, retries: 0, retriesExhausted: 0, blocks: 0, rows: 0, reorgs: 0 })
  })

  test('returns independent objects each call', () => {
    const a = newStats()
    const b = newStats()
    expect(a).not.toBe(b)
    a.retries = 7
    a.blocks = 3
    expect(b.retries).toBe(0)
    expect(b.blocks).toBe(0)
  })
})

describe('createLogger — level is set and respected', () => {
  test('defaults to info; emits info+ and drops trace/debug', () => {
    const cap = capture()
    const log = createLogger('info', cap.stream)
    expect(log.level).toBe('info')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    const levels = cap.records().map((r) => r.level)
    // pino encodes levels numerically: info=30, warn=40, error=50.
    expect(levels).toEqual([30, 40, 50])
  })

  test('createLogger() with no args defaults to info', () => {
    expect(createLogger().level).toBe('info')
  })

  test('a warn-level logger does NOT emit on info but does on warn/error', () => {
    const cap = capture()
    const log = createLogger('warn', cap.stream)
    expect(log.level).toBe('warn')
    log.info('nope')
    expect(cap.count()).toBe(0)
    log.warn('yes')
    log.error('yes')
    expect(cap.records().map((r) => r.level)).toEqual([40, 50])
  })

  test('a trace-level logger emits everything', () => {
    const cap = capture()
    const log = createLogger('trace', cap.stream)
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(cap.records().map((r) => r.level)).toEqual([10, 20, 30, 40, 50])
  })

  test('an error-level logger emits only error', () => {
    const cap = capture()
    const log = createLogger('error', cap.stream)
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('boom')
    const recs = cap.records()
    expect(recs).toHaveLength(1)
    expect(recs[0]?.level).toBe(50)
    expect(recs[0]?.msg).toBe('boom')
  })
})

describe('createLogger — silenceable', () => {
  test("createLogger('silent') emits nothing at any level", () => {
    const cap = capture()
    const log = createLogger('silent', cap.stream)
    expect(log.level).toBe('silent')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(cap.count()).toBe(0)
  })
})

describe('createLogger — both call forms', () => {
  test('(msg) form records the bare string as msg', () => {
    const cap = capture()
    createLogger('info', cap.stream).info('hello')
    const rec = cap.records()[0]
    expect(rec?.msg).toBe('hello')
  })

  test('(obj, msg) form merges the object and records the message', () => {
    const cap = capture()
    createLogger('info', cap.stream).info({ block: 42 }, 'synced')
    const rec = cap.records()[0]
    expect(rec?.block).toBe(42)
    expect(rec?.msg).toBe('synced')
  })

  test('(obj) form with no message merges just the object', () => {
    const cap = capture()
    createLogger('info', cap.stream).warn({ attempt: 3, delay: 100 })
    const rec = cap.records()[0]
    expect(rec?.attempt).toBe(3)
    expect(rec?.delay).toBe(100)
    expect(rec?.level).toBe(40)
  })
})

describe('defaultLogger', () => {
  test('is an info-level logger', () => {
    expect(defaultLogger.level).toBe('info')
  })
})

describe('makeDispatch', () => {
  const quietLogger: Logger = createLogger('silent')

  function setup(run: RunOptions = {}): { stats: Stats; dispatch: ReturnType<typeof makeDispatch> } {
    const stats = newStats()
    return { stats, dispatch: makeDispatch(run, stats, quietLogger) }
  }

  test('progress bumps stats.blocks/rows and forwards onProgress', () => {
    const onProgress = vi.fn()
    const { stats, dispatch } = setup({ onProgress })
    dispatch.progress({ from: 100, to: 109, rows: 4 })
    expect(stats.blocks).toBe(10) // 109 - 100 + 1
    expect(stats.rows).toBe(4)
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ from: 100, to: 109, rows: 4 })
  })

  test('progress accumulates across calls', () => {
    const { stats, dispatch } = setup()
    dispatch.progress({ from: 0, to: 0, rows: 1 }) // 1 block
    dispatch.progress({ from: 1, to: 3, rows: 2 }) // 3 blocks
    expect(stats.blocks).toBe(4)
    expect(stats.rows).toBe(3)
  })

  test('progress without onProgress still bumps stats (no throw)', () => {
    const { stats, dispatch } = setup()
    expect(() => dispatch.progress({ from: 5, to: 5, rows: 0 })).not.toThrow()
    expect(stats.blocks).toBe(1)
  })

  test('error forwards to onError', () => {
    const onError = vi.fn()
    const { dispatch } = setup({ onError })
    const err = new Error('boom')
    dispatch.error(err)
    expect(onError).toHaveBeenCalledExactlyOnceWith(err)
  })

  test('error without onError is a no-op (no throw)', () => {
    const { dispatch } = setup()
    expect(() => dispatch.error(new Error('x'))).not.toThrow()
  })

  test('reorg increments stats.reorgs and forwards onReorg', () => {
    const onReorg = vi.fn()
    const { stats, dispatch } = setup({ onReorg })
    const info: ReorgInfo = { from: 200, to: 195, depth: 5 }
    dispatch.reorg(info)
    expect(stats.reorgs).toBe(1)
    expect(onReorg).toHaveBeenCalledExactlyOnceWith(info)
  })
})
