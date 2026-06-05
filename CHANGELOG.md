# @iankressin/contract-state

## 0.2.0

### Minor Changes

- 0.2.0 — typed errors, operability, and a packaged, documented release.

  This release hardens the library for production use: failures are now typed
  and surfaced instead of swallowed, the pipeline is observable and cancellable,
  inputs are validated up front, and the package ships with full docs, CI, and a
  tag-triggered publish flow.

  ### Breaking changes

  - **Package renamed** `@subsquid/contract-state` → `@iankressin/contract-state`.
    Update your imports and `package.json` dependency. There is no compatibility
    shim under the old name.
  - **Typed errors replace generic `Error`.** Everything the library throws is now
    a `ContractStateError` subclass with a stable `code`:
    `ConfigError` (`CONFIG`), `LayoutError` (`LAYOUT`), `DecodingError` (`DECODING`),
    `SinkError` (`SINK`), and `PortalError` (`PORTAL`). Code that matched on error
    messages should switch to `instanceof` / `err.code`.
  - **`.run()` / `.collect()` take an options bag.** Signatures are now
    `run(range?, opts?)` and `collect(range, opts?)`, where `opts` carries
    `signal`, lifecycle callbacks, failure policy, and retry policy. Positional
    call sites that passed anything beyond the range must move those arguments into
    the options object.
  - **Progress output is an injectable pino logger.** The previous `console.log`
    progress reporting was removed in favor of a structured pino logger you can
    supply (or silence). Anything that parsed stdout progress lines must adapt.
  - **`PostgresSink` slot-label inserts are parameterized.** Slot labels now flow
    through parameterized SQL instead of being interpolated, closing an injection
    vector. Behavior is unchanged for well-formed labels.

  ### Added

  - **Configurable failure policy.** `strict` mode throws `DecodingError` on data
    anomalies; the default resilient mode warns and increments
    `stats.droppedLogs` so a bad row never silently aborts a long backfill.
  - **Resilience on the Portal / Postgres seam.** A `withRetry` wrapper with an
    exponential-backoff-plus-jitter `retry` policy retries transient I/O failures.
  - **Cancellation via `AbortSignal`.** Pass `signal` to `.run()` / `.collect()`
    to cooperatively stop a stream.
  - **Lifecycle callbacks + `Stats`.** `onProgress`, `onError`, and `onReorg`
    hooks, plus a `Stats` object tracking blocks, rows, reorgs, and dropped logs.
  - **Eager input validation.** `.validate()` returns structured `Problem[]` before
    you run, and `.getConfig()` returns the resolved configuration for inspection.
  - **Reusable cursor utilities.** `Cursor`, `MemoryCursor`, and `withCursor` let
    custom sinks implement resume-from-last-block without re-deriving the logic.
  - **Surfaced event-decode failures.** Event-decoding errors that were previously
    swallowed are now reported through the failure policy.
  - **Duplicate `.track()` names are rejected** with a `ConfigError` instead of one
    tracked target silently shadowing another.

  ### Tooling & docs

  - Biome for lint/format.
  - GitHub Actions CI on Node 22 with a coverage threshold gate.
  - Changesets-driven versioning and a tag-triggered (`v*`) publish workflow with
    npm provenance.
  - Typedoc API reference; README badges, FAQ, and a migration note.
  - `docs/semantics.md` documenting the data/ordering semantics.
  - Community health files (`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, issue/PR
    templates), `SECURITY.md`, and Dependabot.
