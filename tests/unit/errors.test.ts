import { describe, expect, test } from 'vitest'
import { ConfigError, ContractStateError, DecodingError, LayoutError, PortalError, SinkError } from '../../src/errors.ts'

const subclasses = [
  { Ctor: ConfigError, name: 'ConfigError', code: 'CONFIG_BAD' },
  { Ctor: LayoutError, name: 'LayoutError', code: 'LAYOUT_BAD' },
  { Ctor: DecodingError, name: 'DecodingError', code: 'DECODE_BAD' },
  { Ctor: SinkError, name: 'SinkError', code: 'SINK_BAD' },
  { Ctor: PortalError, name: 'PortalError', code: 'PORTAL_BAD' },
] as const

describe('ContractStateError subclasses', () => {
  for (const { Ctor, name, code } of subclasses) {
    describe(name, () => {
      test('is instanceof both its subclass, ContractStateError and Error', () => {
        const err = new Ctor('boom', code)
        expect(err).toBeInstanceOf(Ctor)
        expect(err).toBeInstanceOf(ContractStateError)
        expect(err).toBeInstanceOf(Error)
      })

      test('sets name, code and message', () => {
        const err = new Ctor('boom', code)
        expect(err.name).toBe(name)
        expect(err.code).toBe(code)
        expect(err.message).toBe('boom')
      })

      test('propagates cause when passed', () => {
        const cause = new Error('root')
        const err = new Ctor('boom', code, { cause })
        expect(err.cause).toBe(cause)
      })

      test('cause is absent when not passed', () => {
        const err = new Ctor('boom', code)
        expect(err.cause).toBeUndefined()
        expect('cause' in err).toBe(false)
      })

      test('is catchable as ContractStateError', () => {
        let caught: unknown
        try {
          throw new Ctor('boom', code)
        } catch (e) {
          caught = e
        }
        expect(caught).toBeInstanceOf(ContractStateError)
        expect((caught as ContractStateError).code).toBe(code)
      })
    })
  }

  test('cause can be a non-Error value', () => {
    const err = new ConfigError('boom', 'CONFIG_BAD', { cause: 'a string cause' })
    expect(err.cause).toBe('a string cause')
  })

  test('explicit { cause: undefined } leaves cause absent', () => {
    const err = new ConfigError('boom', 'CONFIG_BAD', { cause: undefined })
    expect(err.cause).toBeUndefined()
    expect('cause' in err).toBe(false)
  })

  test('a subclass instance is not an instance of a sibling subclass', () => {
    expect(new ConfigError('x', 'CONFIG_X')).not.toBeInstanceOf(SinkError)
  })

  test('subclasses share the prototype chain up to Error (setPrototypeOf fix)', () => {
    const err = new PortalError('x', 'PORTAL_X')
    expect(Object.getPrototypeOf(err)).toBe(PortalError.prototype)
    expect(Object.getPrototypeOf(PortalError.prototype)).toBe(ContractStateError.prototype)
    expect(Object.getPrototypeOf(ContractStateError.prototype)).toBe(Error.prototype)
  })
})
