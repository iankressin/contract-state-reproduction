/**
 * `ContractState` — the fluent, explicit, code-first way to reproduce a contract's storage.
 * It is a typed assembler: it accumulates the contract, portal, range, and tracked variables,
 * then builds the internal config and hands it to the proven `indexState` engine. It adds no
 * indexing behavior of its own — only construction plus the checks the engine can't make
 * (portal set, deploy block set, sink set).
 *
 *   await ContractState
 *     .forContract('0x6B17…1d0F')
 *     .onPortal('https://portal.sqd.dev/datasets/ethereum-mainnet')
 *     .deployedAt(8_928_674)
 *     .track(scalar('totalSupply', { slot: 1, type: 'uint256' }))
 *     .track(mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' })
 *       .keysFrom('event Transfer(address indexed src,address indexed dst,uint256 wad)', [['src'], ['dst']]))
 *     .into(PostgresSink.fromConnectionString(process.env.DB_URL!))
 *     .run({ to: 8_932_674 })
 */
import { type JobConfig, type ResolvedConfig, resolveConfig, type SourceConfig } from './config.ts'
import { ConfigError } from './errors.ts'
import { indexState } from './indexer.ts'
import type { RunOptions } from './options.ts'
import type { RowBatch } from './pipeline.ts'
import type { BlockRange } from './query.ts'
import { MemorySink, type StateSink } from './sink.ts'
import type { TrackSpec } from './track.ts'

/** Entry point for the fluent builder. */
export class ContractState {
  /** Start describing the contract whose storage you want to reproduce. */
  static forContract(address: string): ContractStateBuilder {
    return new ContractStateBuilder(address)
  }
}

export class ContractStateBuilder {
  private readonly _address: string
  private _portalUrl?: string
  private _deployBlock?: number
  private _source?: SourceConfig
  private _id?: string
  private _sink?: StateSink
  private readonly _specs: TrackSpec[] = []

  /** @internal — use `ContractState.forContract(address)`. */
  constructor(address: string) {
    this._address = address
  }

  /** Portal dataset URL (selects the chain). Required — there is no environment fallback. */
  onPortal(url: string): this {
    this._portalUrl = url
    return this
  }

  /** Contract deploy block. The default start of the indexed range. */
  deployedAt(block: number): this {
    this._deployBlock = block
    return this
  }

  /** Solidity source for solc-derived shapes — only needed when a spec is `derived(...)`. */
  fromSource(source: SourceConfig): this {
    this._source = source
    return this
  }

  /**
   * Stable cursor key for resumable Postgres runs. Defaults to the lowercased address.
   * Set this explicitly when indexing the SAME contract with different variable sets into one
   * database — two runs sharing an id share (and overwrite) each other's cursor.
   */
  withId(id: string): this {
    this._id = id
    return this
  }

  /** Where rows land: `PostgresSink`, `MemorySink`, or any custom `StateSink`. */
  into(sink: StateSink): this {
    this._sink = sink
    return this
  }

  /** Add one or more tracked variables. Repeatable; varargs. Use `scalar`/`mapping`/`derived`. */
  track(...specs: TrackSpec[]): this {
    this._specs.push(...specs)
    return this
  }

  /**
   * Run the indexer. With no range: backfill `deployBlock` -> head, then follow live (use a
   * `PostgresSink` — it rolls back reorgs and persists a cursor). With `{ from, to }`: index a
   * bounded window.
   */
  async run(range?: BlockRange, opts?: RunOptions): Promise<void> {
    const config = this.resolve()
    if (this._sink == null) throw new ConfigError('ContractState: no sink — call .into(sink) before .run()', 'CONFIG_NO_SINK')
    await indexState(config, this._sink, range, opts)
  }

  /**
   * Index a BOUNDED range into memory and return the decoded rows. Convenience for tests,
   * scripts, and one-off reconstructions — no database, no Drizzle. `to` is required: `MemorySink`
   * does no reorg rollback and buffers everything, so it must not follow the chain unbounded.
   */
  async collect(range: BlockRange, opts?: RunOptions): Promise<RowBatch> {
    if (range.to == null) {
      throw new ConfigError('collect() needs a bounded range { from, to }; for live follow use .into(sink).run()', 'CONFIG_UNBOUNDED_COLLECT')
    }
    const config = this.resolve()
    const sink = new MemorySink()
    await indexState(config, sink, range, opts)
    return sink.rows
  }

  /** Build + validate the internal config; reuses `resolveConfig` for address/track checks. */
  private resolve(): ResolvedConfig {
    if (this._portalUrl == null || this._portalUrl === '') {
      throw new ConfigError('ContractState: no portal — call .onPortal(url) before running', 'CONFIG_NO_PORTAL')
    }
    if (this._deployBlock == null) {
      throw new ConfigError('ContractState: no deploy block — call .deployedAt(block) before running', 'CONFIG_NO_DEPLOY_BLOCK')
    }
    const jobConfig: JobConfig = {
      id: this._id ?? this._address.toLowerCase(),
      address: this._address,
      deployBlock: this._deployBlock,
      ...(this._source ? { source: this._source } : {}),
      trackedVariables: this._specs.map((s) => s._tracked),
    }
    return resolveConfig(jobConfig, this._portalUrl)
  }
}
