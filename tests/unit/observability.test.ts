import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createLogger, defaultLogger, newStats } from '../../src/observability.ts'

let debug: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('newStats', () => {
  test('returns all-zero counters', () => {
    expect(newStats()).toEqual({ droppedLogs: 0, retries: 0, retriesExhausted: 0 })
  })

  test('returns independent objects each call', () => {
    const a = newStats()
    const b = newStats()
    expect(a).not.toBe(b)
    a.retries = 7
    expect(b.retries).toBe(0)
  })
})

describe('createLogger — level filtering', () => {
  test('defaults to info (debug/trace dropped, info+ emitted)', () => {
    const log = createLogger()
    expect(log.level).toBe('info')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(debug).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  test('a warn-level logger drops info but emits warn and error', () => {
    const log = createLogger('warn')
    log.info('nope')
    expect(info).not.toHaveBeenCalled()
    log.warn('yes')
    log.error('yes')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  test('a trace-level logger emits everything (trace/debug → console.debug)', () => {
    const log = createLogger('trace')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(debug).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  test('an error-level logger emits only error', () => {
    const log = createLogger('error')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(debug).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('createLogger — silent', () => {
  test('emits nothing at any level', () => {
    const log = createLogger('silent')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(debug).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('createLogger — call signatures', () => {
  test('(msg) form passes the bare string', () => {
    createLogger('info').info('hello')
    expect(info).toHaveBeenCalledWith('hello')
  })

  test('(obj, msg) form passes object then message', () => {
    const obj = { block: 42 }
    createLogger('info').info(obj, 'synced')
    expect(info).toHaveBeenCalledWith(obj, 'synced')
  })

  test('(obj) form with no message passes just the object', () => {
    const obj = { block: 42 }
    createLogger('info').warn(obj)
    expect(warn).toHaveBeenCalledWith(obj)
  })
})

describe('defaultLogger', () => {
  test('is an info-level logger', () => {
    expect(defaultLogger.level).toBe('info')
    defaultLogger.debug('nope')
    expect(debug).not.toHaveBeenCalled()
    defaultLogger.info('yes')
    expect(info).toHaveBeenCalledTimes(1)
  })
})
