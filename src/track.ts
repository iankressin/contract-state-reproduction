/**
 * Track-spec helpers for the fluent builder: the ergonomic, self-documenting way to declare
 * WHAT to track. Each helper returns a `TrackSpec` that the builder turns into the internal
 * `TrackedVariable` shape at run time. This is the single place public names map to internal ones:
 *
 *   scalar(v, { slot, offset?, type, bits? })            -> { variable, shape:{slot,offset,valueType}, decodeBits }
 *   mapping(v, { slot, keys, value, bits? }).keysFrom(…)  -> { variable, shape:{slot,keyTypes,valueType}, decodeBits, keySources }
 *   derived(v).keysFrom(…)                                -> { variable, keySources }   (no shape -> solc-derived)
 */
import type { KeySource, TrackedVariable } from './config.ts'
import { ConfigError } from './errors.ts'

/** Inline shape of a scalar (or a packed struct field via a dotted `variable`, e.g. 'slot0.tick'). */
export type ScalarShape = {
  /** Declaration slot of the variable. */
  slot: number
  /** Packing offset, in bytes from the slot's least-significant end (default 0). */
  offset?: number
  /** Solidity value type, e.g. 'uint256' | 'address' | 'bool' | 'bytes32' | 'int24'. */
  type: string
  /** Optional low-bit mask on the decoded value (e.g. 255 for USDC v2.2's packed flag). */
  bits?: number
}

/** Inline shape of a (single or nested, depth <= 2) mapping. */
export type MappingShape = {
  /** Declaration (base) slot of the mapping. */
  slot: number
  /** Solidity key types, outer -> inner, e.g. ['address'] or ['address','address']. */
  keys: string[]
  /** Solidity value type, e.g. 'uint256'. */
  value: string
  /** Optional low-bit mask on the decoded value. */
  bits?: number
}

/**
 * A declaration of one tracked variable. Build it with `scalar()`, `mapping()`, or `derived()` —
 * never construct directly. Mapping/derived specs accept `.keysFrom()` to bind their event keys.
 */
export class TrackSpec {
  /** @internal — consumed by the builder; not part of the ergonomic surface. */
  readonly _tracked: TrackedVariable
  private readonly _allowsKeys: boolean

  /** @internal — use `scalar()` / `mapping()` / `derived()`. */
  constructor(tracked: TrackedVariable, allowsKeys: boolean) {
    this._tracked = tracked
    this._allowsKeys = allowsKeys
  }

  /**
   * Bind the event(s) whose args carry this mapping's keys. Repeatable for multiple events.
   * `at` is a list of key-paths; each path's length must equal the mapping depth, e.g.
   *   balanceOf: keysFrom('event Transfer(...)', [['src'], ['dst']])      // two single-key paths
   *   allowance: keysFrom('event Approval(...)', [['src', 'guy']])        // one two-key path
   */
  keysFrom(event: string, at: string[][]): this {
    if (!this._allowsKeys) {
      throw new ConfigError(`${this._tracked.variable}: scalar()/struct fields take no keysFrom — only mapping()/derived() do`, 'CONFIG_KEYSFROM_ON_SCALAR')
    }
    ;(this._tracked.keySources ??= []).push({ eventAbi: event, keyTuples: at } satisfies KeySource)
    return this
  }
}

/** Track a scalar value type at a fixed slot (or a packed struct field via a dotted name). */
export function scalar(variable: string, shape: ScalarShape): TrackSpec {
  return new TrackSpec(
    {
      variable,
      shape: {
        slot: shape.slot,
        ...(shape.offset != null ? { offset: shape.offset } : {}),
        valueType: shape.type,
      },
      ...(shape.bits != null ? { decodeBits: shape.bits } : {}),
    },
    false,
  )
}

/** Track a mapping (single or nested). Bind its keys with `.keysFrom(event, at)`. */
export function mapping(variable: string, shape: MappingShape): TrackSpec {
  return new TrackSpec(
    {
      variable,
      shape: { slot: shape.slot, keyTypes: shape.keys, valueType: shape.value },
      ...(shape.bits != null ? { decodeBits: shape.bits } : {}),
    },
    true,
  )
}

/**
 * Track a variable whose shape is derived from Solidity source (set via the builder's
 * `.fromSource(...)`). The kind (scalar / mapping / struct expansion) is auto-detected by solc.
 * If it resolves to a mapping, bind its keys with `.keysFrom(...)`.
 */
export function derived(variable: string): TrackSpec {
  return new TrackSpec({ variable }, true)
}
