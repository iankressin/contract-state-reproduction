/**
 * Typed error hierarchy for `@iankressin/contract-state`.
 *
 * Every error this library throws on purpose is a {@link ContractStateError} subclass, so callers
 * can `catch (e) { if (e instanceof ContractStateError) ... }` and branch on a stable, machine-
 * readable {@link ContractStateError.code | code} without string-matching messages. Each subclass
 * owns a `code` namespace (SCREAMING_SNAKE, prefixed by the subclass): `CONFIG_*`, `LAYOUT_*`,
 * `DECODE_*`, `SINK_*`, `PORTAL_*`.
 */

/**
 * Abstract base for all library errors. Carries a stable {@link code} and an optional
 * {@link cause}. Not constructed directly — throw one of the concrete subclasses.
 *
 * The `Object.setPrototypeOf` call in the constructor restores the prototype chain so that
 * `instanceof` works for subclasses even when compiled down to ES5-era `extends Error`
 * semantics (the well-known TypeScript/Babel extends-builtin pitfall).
 */
export abstract class ContractStateError extends Error {
  /** Discriminant matching the subclass name, e.g. `'ConfigError'`. */
  abstract readonly name: string
  /** Stable, machine-readable error code (SCREAMING_SNAKE, namespaced by subclass). */
  readonly code: string
  /**
   * The underlying error or value that triggered this one, if any.
   *
   * Declared with `declare` so TypeScript emits no field initializer for it — otherwise
   * `useDefineForClassFields` would materialize an own `cause: undefined` property on every
   * instance, and `'cause' in err` would be `true` even when none was provided. With `declare`,
   * the constructor's conditional assignment below is the only writer, so the property is genuinely
   * absent unless a `cause` is passed.
   */
  declare readonly cause?: unknown

  /**
   * @param message Human-readable description.
   * @param code Stable error code (SCREAMING_SNAKE, namespaced by subclass).
   * @param options Optional `{ cause }` to chain the originating error.
   */
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message)
    this.code = code
    if (options?.cause !== undefined) this.cause = options.cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Invalid or inconsistent job configuration (bad address, empty tracked variables, …). Code prefix: `CONFIG_*`. */
export class ConfigError extends ContractStateError {
  readonly name = 'ConfigError'
}

/** Storage-layout resolution failure (solc compile error, unresolved variable, …). Code prefix: `LAYOUT_*`. */
export class LayoutError extends ContractStateError {
  readonly name = 'LayoutError'
}

/** Failure while decoding a raw storage word into a typed value. Code prefix: `DECODE_*`. */
export class DecodingError extends ContractStateError {
  readonly name = 'DecodingError'
}

/** Failure while persisting decoded rows to a sink (DB write, connection, …). Code prefix: `SINK_*`. */
export class SinkError extends ContractStateError {
  readonly name = 'SinkError'
}

/** Failure talking to the Portal / upstream data source. Code prefix: `PORTAL_*`. */
export class PortalError extends ContractStateError {
  readonly name = 'PortalError'
}
