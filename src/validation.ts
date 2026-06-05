/**
 * The single source of truth for STATIC input validation.
 *
 * Every function here is a pure validator: it never throws and never performs I/O — it RETURNS a
 * list of structured {@link Problem}s (empty = valid). This lets two very different call sites share
 * one rule set:
 *
 *   - the fluent builder's `.validate()` can surface ALL problems at once (a report), and
 *   - `resolveConfig`'s throw-path can map the FIRST problem to a `ConfigError(message, code)`.
 *
 * The {@link Problem.code}s deliberately mirror the Phase-0 `ConfigError` codes already thrown by
 * `config.ts`/`builder.ts`/`pipeline.ts`, so wiring a validator into a throw-path is a 1:1 swap:
 * `const [p] = validateBuilderInput(input); if (p) throw new ConfigError(p.message, p.code)`.
 *
 * Scope: only what is statically checkable from raw input. Rules that need the RESOLVED storage
 * layout — mapping depth vs key-tuple arity, whether a `derived` variable is actually a mapping —
 * stay in `buildTrackingContext` (which owns the resolved `Plan`). This module checks the
 * arity-CONSISTENCY that is knowable without solc (all key-tuples of one variable share a length),
 * and never re-implements the resolved-layout checks.
 *
 * Imports are type-only from `config.ts`/`query.ts` so this module stays free of runtime coupling
 * (no `errors.ts` import — it returns problems, it does not throw them).
 */
import type { KeySource, TrackedVariable } from './config.ts'
import type { BlockRange } from './query.ts'

/**
 * One structured validation failure.
 *
 * @property path Dotted location of the offending input, e.g. `'address'`, `'range.from'`,
 *   `'trackedVariables[2].keySources'`. Stable enough to point a user at the exact field.
 * @property code Stable, machine-readable code matching a Phase-0 `ConfigError` code
 *   (SCREAMING_SNAKE, `CONFIG_*`). The throw-path uses this verbatim.
 * @property message Human-readable, actionable description.
 */
export interface Problem {
  path: string
  code: string
  message: string
}

/** Matches a 20-byte hex address (`0x` + 40 hex chars). Same regex `resolveConfig` enforces. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** True for a finite, non-negative integer (block heights and range bounds). */
function isNonNegativeInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 0
}

/**
 * Validate a contract address.
 *
 * @param address The candidate address, or `undefined` if never set.
 * @returns `[]` when present and a valid `0x`-prefixed 20-byte hex string; otherwise a single
 *   problem — `CONFIG_NO_ADDRESS` when missing/empty, `CONFIG_INVALID_ADDRESS` when malformed.
 */
export function validateAddress(address: string | undefined): Problem[] {
  if (address == null || address === '') {
    return [{ path: 'address', code: 'CONFIG_NO_ADDRESS', message: 'No contract address — set the contract address before running' }]
  }
  if (!ADDRESS_RE.test(address)) {
    return [{ path: 'address', code: 'CONFIG_INVALID_ADDRESS', message: `Invalid contract address: ${address} — expected a 0x-prefixed 20-byte hex string` }]
  }
  return []
}

/**
 * Validate the Portal dataset URL.
 *
 * Must be present and a parseable absolute URL whose protocol is `http:` or `https:`. Parsing uses
 * `new URL()` in a try/catch so malformed input is reported, not thrown.
 *
 * @param url The candidate Portal URL, or `undefined` if never set.
 * @returns `[]` when valid; otherwise a single problem — `CONFIG_NO_PORTAL` when missing/empty,
 *   `CONFIG_INVALID_PORTAL_URL` when unparseable or not http(s).
 */
export function validatePortalUrl(url: string | undefined): Problem[] {
  if (url == null || url === '') {
    return [{ path: 'portalUrl', code: 'CONFIG_NO_PORTAL', message: 'No portal — set the Portal dataset URL before running' }]
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return [{ path: 'portalUrl', code: 'CONFIG_INVALID_PORTAL_URL', message: `Invalid portal URL: ${url} — could not be parsed as a URL` }]
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return [
      {
        path: 'portalUrl',
        code: 'CONFIG_INVALID_PORTAL_URL',
        message: `Invalid portal URL: ${url} — protocol must be http or https, got ${parsed.protocol}`,
      },
    ]
  }
  return []
}

/**
 * Validate the contract deploy block.
 *
 * @param block The candidate deploy block, or `undefined` if never set.
 * @returns `[]` when present and a finite, non-negative integer; otherwise a single problem —
 *   `CONFIG_NO_DEPLOY_BLOCK` when missing, `CONFIG_INVALID_DEPLOY_BLOCK` when negative, fractional,
 *   or non-finite.
 */
export function validateDeployBlock(block: number | undefined): Problem[] {
  if (block == null) {
    return [{ path: 'deployBlock', code: 'CONFIG_NO_DEPLOY_BLOCK', message: 'No deploy block — set the contract deploy block before running' }]
  }
  if (!isNonNegativeInteger(block)) {
    return [{ path: 'deployBlock', code: 'CONFIG_INVALID_DEPLOY_BLOCK', message: `Invalid deploy block: ${block} — expected a non-negative integer` }]
  }
  return []
}

/**
 * Validate an explicit block range against the (optional) deploy block.
 *
 * Only enforced when a range is given (an omitted range means "backfill from deployBlock to head",
 * which is always valid). Sub-rules, each with its own message under code `CONFIG_INVALID_RANGE`:
 *   - `from` must be a finite, non-negative integer;
 *   - if `to` is present it must be a finite, non-negative integer and `from <= to` (a single-block
 *     window `from === to` is allowed);
 *   - when `deployBlock` is known, `from >= deployBlock` (you cannot index before deployment).
 *
 * @param range The explicit `{ from, to? }` window, or `undefined` to backfill-then-follow.
 * @param deployBlock The deploy block if known, to enforce `from >= deployBlock`; omit if unknown.
 * @returns `[]` when valid or when no range is given; otherwise one problem per violated sub-rule.
 */
export function validateRange(range: BlockRange | undefined, deployBlock?: number): Problem[] {
  if (range == null) return []
  const problems: Problem[] = []
  if (!isNonNegativeInteger(range.from)) {
    problems.push({ path: 'range.from', code: 'CONFIG_INVALID_RANGE', message: `Invalid range: from=${range.from} — expected a non-negative integer` })
  }
  if (range.to != null) {
    if (!isNonNegativeInteger(range.to)) {
      problems.push({ path: 'range.to', code: 'CONFIG_INVALID_RANGE', message: `Invalid range: to=${range.to} — expected a non-negative integer` })
    } else if (isNonNegativeInteger(range.from) && range.from > range.to) {
      problems.push({ path: 'range', code: 'CONFIG_INVALID_RANGE', message: `Invalid range: from=${range.from} is after to=${range.to} — from must be <= to` })
    }
  }
  if (deployBlock != null && isNonNegativeInteger(range.from) && range.from < deployBlock) {
    problems.push({
      path: 'range.from',
      code: 'CONFIG_INVALID_RANGE',
      message: `Invalid range: from=${range.from} is before deployBlock=${deployBlock} — cannot index before deployment`,
    })
  }
  return problems
}

/**
 * Decide whether a tracked variable is statically known to be a MAPPING (so its keys must come from
 * events). True when the inline shape declares `keyTypes`, OR when `keySources` are bound (only
 * mappings/`derived` accept `.keysFrom`). A solc-`derived` variable with no `keySources` yet is NOT
 * forced to be a mapping here — that determination needs the resolved layout.
 */
function impliesMapping(v: TrackedVariable): boolean {
  return (v.shape?.keyTypes?.length ?? 0) > 0 || (v.keySources?.length ?? 0) > 0
}

/** The longest key-tuple length declared across one variable's key sources, or `undefined` if none. */
function maxKeyTupleArity(keySources: KeySource[]): number | undefined {
  let max: number | undefined
  for (const ks of keySources) {
    for (const tuple of ks.keyTuples) {
      if (max === undefined || tuple.length > max) max = tuple.length
    }
  }
  return max
}

/**
 * Validate the tracked-variables list.
 *
 * Checks, in order:
 *   - non-empty (`CONFIG_NO_TRACKED_VARS`);
 *   - no duplicate `variable` names — two specs sharing a name would silently overwrite each other
 *     in the pipeline's decoder map (`CONFIG_DUPLICATE_VARIABLE`, message names the dup);
 *   - every variable that statically implies a mapping has at least one `keySources` entry
 *     (`CONFIG_MISSING_KEY_SOURCES`);
 *   - within a single variable, all key-tuples share one arity — mixed lengths can't all match a
 *     single mapping depth (`CONFIG_KEY_TUPLE_ARITY`). The depth-vs-arity check that needs the
 *     resolved layout stays in `buildTrackingContext`.
 *
 * @param vars The tracked variables (internal `TrackedVariable` shape).
 * @returns `[]` when valid; otherwise the accumulated problems.
 */
export function validateTrackedVariables(vars: TrackedVariable[] | undefined): Problem[] {
  if (vars == null || vars.length === 0) {
    return [{ path: 'trackedVariables', code: 'CONFIG_NO_TRACKED_VARS', message: 'No tracked variables — nothing to track; add at least one variable' }]
  }
  const problems: Problem[] = []
  const seen = new Set<string>()
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i]!
    if (seen.has(v.variable)) {
      problems.push({
        path: `trackedVariables[${i}].variable`,
        code: 'CONFIG_DUPLICATE_VARIABLE',
        message: `Duplicate tracked variable "${v.variable}" — each variable may be tracked only once`,
      })
    }
    seen.add(v.variable)

    if (impliesMapping(v) && !(v.keySources?.length ?? 0)) {
      problems.push({
        path: `trackedVariables[${i}].keySources`,
        code: 'CONFIG_MISSING_KEY_SOURCES',
        message: `mapping "${v.variable}" needs keySources (events to discover its keys)`,
      })
    }

    if (v.keySources?.length) {
      // Static consistency only: all key-tuples for THIS variable must share one arity. We can't
      // know the mapping depth without the resolved layout, but mixed arities can never all match it.
      const arities = new Set<number>()
      for (const ks of v.keySources) for (const tuple of ks.keyTuples) arities.add(tuple.length)
      if (arities.size > 1) {
        const widest = maxKeyTupleArity(v.keySources)
        problems.push({
          path: `trackedVariables[${i}].keySources`,
          code: 'CONFIG_KEY_TUPLE_ARITY',
          message: `${v.variable}: key tuples have inconsistent lengths [${[...arities].sort((a, b) => a - b).join(', ')}] — every key path must have the same arity (the mapping depth, here at most ${widest})`,
        })
      }
    }
  }
  return problems
}

/**
 * The accumulated, builder-/config-shaped input to validate. Every field is optional so a builder
 * holding partial state (`_address`, `_portalUrl`, `_deployBlock`, `_specs.map(s => s._tracked)`,
 * an optional run range) can call this at any point, AND `resolveConfig` can call it with a fully
 * assembled config.
 */
export interface BuilderInput {
  /** Contract address (`forContract`). */
  address?: string
  /** Portal dataset URL (`onPortal`). */
  portalUrl?: string
  /** Contract deploy block (`deployedAt`). */
  deployBlock?: number
  /** Explicit run window (`run({ from, to })`); omit for backfill-then-follow. */
  range?: BlockRange
  /** Tracked variables in the internal `TrackedVariable` shape (`_specs.map(s => s._tracked)`). */
  trackedVariables?: TrackedVariable[]
}

/**
 * Aggregate validator: run every applicable granular validator and concatenate their problems.
 *
 * Returns `[]` only when the whole input is valid. Problems are ordered by field
 * (address → portal → deploy block → range → tracked variables) so a report reads top-to-bottom.
 *
 * Wiring (next sub-stage 2B):
 *   - `builder.validate()` returns this array verbatim (or formats it) to surface ALL problems at
 *     once, BEFORE any network call.
 *   - `resolveConfig`'s throw-path takes the FIRST problem and throws it:
 *     ```ts
 *     const [problem] = validateBuilderInput({ address, portalUrl, deployBlock, range, trackedVariables })
 *     if (problem) throw new ConfigError(problem.message, problem.code)
 *     ```
 *     Because the codes here match the Phase-0 `ConfigError` codes, this preserves the exact
 *     `.code` callers already branch on.
 *
 * @param input The accumulated builder/config state to validate.
 * @returns All problems found, in field order; `[]` when valid.
 */
export function validateBuilderInput(input: BuilderInput): Problem[] {
  return [
    ...validateAddress(input.address),
    ...validatePortalUrl(input.portalUrl),
    ...validateDeployBlock(input.deployBlock),
    ...validateRange(input.range, input.deployBlock),
    ...validateTrackedVariables(input.trackedVariables),
  ]
}
