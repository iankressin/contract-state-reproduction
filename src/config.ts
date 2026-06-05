/**
 * Job configuration: which contract, over which blocks, which variables to track,
 * how to discover mapping keys from events, and how to decode stored values.
 *
 * A tracked variable is one of:
 *   - a SCALAR value type at a fixed slot (e.g. totalSupply) — no key source needed, or
 *   - a MAPPING (single or nested) keyed by value types (e.g. balanceOf, allowance) —
 *     its keys are discovered from event args.
 *
 * Each variable's SHAPE (slot + key/value types) is either derived from the Solidity
 * source via solc-js, or provided inline via `shape` (for proxies / pre-0.5.13 solc /
 * when source is unavailable).
 */
import type { Hex } from 'viem'
import { ConfigError } from './errors.ts'

export type ValueCategory = 'uint' | 'int' | 'address' | 'bool' | 'bytes'

/** Inline shape for a variable, used when its slot is pinned instead of solc-derived. */
export type ShapeOverride = {
  /** Base storage slot (declaration slot of the variable). */
  slot: number
  /** Scalar packing offset, in bytes from the slot's least-significant end (default 0). */
  offset?: number
  /** Solidity key types for mappings, outer→inner, e.g. ['address'] or ['address','address']. */
  keyTypes?: string[]
  /** Solidity value type, e.g. 'uint256' | 'address' | 'bool' | 'bytes32'. */
  valueType: string
}

export type KeySource = {
  /** Human-readable signature of the event carrying the mapping keys. */
  eventAbi: string
  /**
   * Each tuple is an ordered list of event-arg names forming ONE mapping key path;
   * its length must equal the mapping depth. Multiple tuples = multiple keys per event
   * (e.g. Transfer(from,to) feeds balanceOf at [['from'],['to']]; Approval(owner,spender)
   * feeds allowance at [['owner','spender']]).
   */
  keyTuples: string[][]
}

export type TrackedVariable = {
  /** Variable label as it appears in the storage layout. */
  variable: string
  /** Inline shape; omit to derive the shape from the compiled source. */
  shape?: ShapeOverride
  /** Optional low-bit mask on the decoded value (e.g. 255 for USDC v2.2's packed blacklist flag). */
  decodeBits?: number
  /** Required for mappings: the event(s) whose args carry the keys. Omit for scalars. */
  keySources?: KeySource[]
}

export type SourceConfig = {
  path: string
  contractName: string
  /** Exact solc version, e.g. '0.8.20'. Omit to use the bundled compiler. */
  solcVersion?: string
  optimizer?: { enabled: boolean; runs: number }
  evmVersion?: string
}

export type JobConfig = {
  id: string
  /** Address whose storage we reproduce. For proxied tokens this is the PROXY address. */
  address: string
  deployBlock: number
  /** End block; omit to backfill to head and then follow the chain live. */
  toBlock?: number
  /** Implementation source for solc-derived shapes. Optional if every variable has a `shape`. */
  source?: SourceConfig
  trackedVariables: TrackedVariable[]
}

export type ResolvedConfig = JobConfig & {
  address: Hex
  portalUrl: string
}

/**
 * Validate + normalize a job config, attaching the explicit Portal URL. Internal: the public
 * way to build this is the `ContractState` fluent builder (which passes the URL from `.onPortal`).
 */
export function resolveConfig(cfg: JobConfig, portalUrl: string): ResolvedConfig {
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.address)) throw new ConfigError(`Invalid contract address: ${cfg.address}`, 'CONFIG_INVALID_ADDRESS')
  if (cfg.trackedVariables.length === 0) throw new ConfigError('config.trackedVariables is empty — nothing to track', 'CONFIG_NO_TRACKED_VARS')
  // Reject duplicate tracked-variable names: two specs sharing a `variable` would silently overwrite
  // each other in the pipeline's decoder map (decoders.set(p.variable, …)) — surface it up front.
  const seen = new Set<string>()
  for (const v of cfg.trackedVariables) {
    if (seen.has(v.variable))
      throw new ConfigError(`Duplicate tracked variable "${v.variable}" — each variable may be tracked only once`, 'CONFIG_DUPLICATE_VARIABLE')
    seen.add(v.variable)
  }
  return {
    ...cfg,
    address: cfg.address.toLowerCase() as Hex,
    portalUrl,
  }
}
