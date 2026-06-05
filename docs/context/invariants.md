# INVARIANTS

One line per invariant, grouped under a `##` header naming the **kind of constraint**.
Append your line under the kind it fits; add a new kind-header only if none fits — a kind
is a noun phrase ("Data model", "Decoding limits"), **never a subsystem or module name**.
Treat each line as a **binding constraint** — do not violate it; if a change makes one
obsolete, update it. This terse ledger is the tacit "this assumes X, can't handle Y, watch
out for Z" knowledge that is otherwise lost in agent-driven development.

## Data model
- state_value is append-only event-sourced history (one row per storage write), NOT snapshots; "value at block N" = the latest row with blockNumber ≤ N — there is no row on blocks where the slot didn't change.
- Account-level state diffs (keys 'balance' | 'code' | 'nonce') are skipped; only storage-SLOT diffs reach state_log/state_value.
- Only Solidity value types are decoded into state_value; arrays, strings, dynamic bytes, and non-value struct members are captured RAW in state_log only (structs expand to one scalar plan per value-type member, named "<var>.<member>").

## Decoding rules & limits
- A mapping value is decoded into state_value ONLY when its key-discovering event shares the SAME batch as the storage write (processBatch Pass-1 labels are per-batch in-memory, never read back from slot_label); this works because the event and the write it causes occur in the same transaction → same batch.
- slot_label rows accumulate across batches in Postgres (ON CONFLICT DO NOTHING), but Pass-2 decode uses only the in-batch `labels` map — the DB dictionary is for querying, not for backfilling decode.
- Mapping depth is capped at 2 (decoded layer); each keysFrom tuple length MUST equal the mapping's key-type count or buildTrackingContext throws.
- decodeWord treats null/'0x' as the zero word; fixed bytesN decoding is left-aligned and supports offset 0 only (packed bytesN at a nonzero offset is unsupported).

## Error contract & surfacing
- Every error this library throws on purpose is a ContractStateError subclass (ConfigError/LayoutError/DecodingError/SinkError/PortalError) carrying a stable SCREAMING_SNAKE `code` — no bare `Error` escapes `src/` (enforce with `grep -rn "throw new Error" src` → empty); callers branch on `e.code`, never on message text, and messages are preserved verbatim so message-regex tests keep matching.
- Error-class assignment is by FIXABILITY: user-fixable-via-config/env faults (bad address, missing portal/sink/deploy-block, unbounded collect, solc-not-installed / version-not-found, no-source-no-shape, keysFrom-on-scalar, missing keySources, key-tuple arity, duplicate variable) are ConfigError; faults intrinsic to the storage layout / solc compile are LayoutError; decode-time faults are DecodingError; sink/persistence faults are SinkError.
- A log whose topic0 MATCHED a tracked event but then fails to decode is NEVER silently swallowed: events.ts `reader.decode` returns null ONLY for a genuine topic0 mismatch and THROWS on a real decode failure; pipeline Pass-1 surfaces the throw as strict → DecodingError(DECODE_EVENT_FAILED) vs resilient (default) → logger.warn('dropped undecodable event log') + stats.droppedLogs++ then continue. A non-matching topic0 (no tracker) is still skipped quietly with no droppedLogs.
- The decode path takes NO non-null assertions: both decoder lookups in processBatch Pass-2 (scalar field + mapping label) are guarded — a missing decoder throws DecodingError(DECODE_MISSING_DECODER) rather than `decoders.get(x)!`.

## Observability
- The default Logger is PINO-backed (`createLogger(level?, destination?)` returns a pino instance, narrowed to the Logger interface by a single boundary cast since pino types `.level` wider as LevelWithSilentOrString). The Logger interface, `createLogger`'s name/first-param, and `defaultLogger` are WRITE-ONCE from Phase 0 — `destination?` is an additive testability-only 2nd param. Default level stays 'info'; 'silent' disables all output. Tests capture output via a pino destination stream (collect chunks, parse NDJSON) — NEVER via real stdout or console spies; pino encodes levels numerically (trace10/debug20/info30/warn40/error50).
- Stats is append-only on the Phase-0 fields (droppedLogs/retries/retriesExhausted); blocks/rows/reorgs were APPENDED and newStats() initializes all six to 0 — never reorder. blocks accumulates `to-from+1` per progress event, rows accumulates produced value-row count, reorgs counts onAfterRollback dispatches.
- makeDispatch(run,stats,logger) → {progress,error,reorg} is the ONE place that bumps Stats then calls the user RunOptions callback, so counters can't drift from what callbacks report: progress({from,to,rows}) bumps blocks/rows then run.onProgress; error(err) → run.onError (no-op if unset, never swallows); reorg(info) → stats.reorgs++ then run.onReorg. Decode-drops are observable via stats.droppedLogs + the warn log (NOT via onError — pipeline owns that path and its Phase-0 signature is not re-touched).

## Reorg & failure handling
- Reorg rollback exists ONLY in PostgresSink's Drizzle target (PK-keyed snapshot triggers); MemorySink does NO rollback, so it must stay bounded — collect() requires a `to` block and unbounded follow needs a PostgresSink.
- PostgresSink.consume wraps `stream.pipeTo(target)` in withRetry(…, run.retry, {logger,stats,signal}): transient infra (socket/5xx/429) is retried, config/decode/abort faults stay fatal (default-deny), and a non-ContractStateError failure at the boundary is translated to SinkError(SINK_CONSUME_FAILED, {cause}). MemorySink does NOT retry — a restart would re-consume the stream and duplicate its accumulated batches.
- withRetry (resilience.ts) rethrows the ORIGINAL error unchanged on BOTH the non-retryable and attempts-exhausted paths — it NEVER wraps; the call site is responsible for wrapping into SinkError/PortalError, and the identity rethrown on exhaustion is the LAST attempt's error.
- defaultIsRetryable is default-DENY: retryable iff a known infra code (ECONNRESET/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/EPIPE/ENOTFOUND) OR HTTP status ≥500 or ===429; AbortError and everything else (incl. ConfigError/LayoutError/DecodingError, which carry no network code) are fatal — library faults are never retried by accident.
- withRetry backoff is fully deterministic under injection: clock, sleep, and the jitter rng are all injectable; delay = min(maxMs, baseMs·factor^(attempt-1)) blended as cap·(1-jitter)+rng()·cap·jitter (jitter clamped to [0,1]). Tests MUST inject sleep/rng — never rely on real timers.
- Aborting `opts.signal` stops the consume loop at the NEXT batch boundary and the run/collect RESOLVES CLEANLY (no throw) with partial results: MemorySink checks `run.signal?.aborted` at the top of the for-await body and `break`s (returns normally); PostgresSink calls `run.signal?.throwIfAborted()` at the top of onData, the AbortError propagates out of pipeTo, withRetry treats it as fatal (default-deny), and the consume catch recognizes `err?.name === 'AbortError'` and returns (does NOT wrap as SinkError). ContractStateError still rethrows as-is; only genuinely-unknown errors become SinkError(SINK_CONSUME_FAILED). MemorySink stays bounded — partial-on-abort does not change that.
- Reorg→onReorg is wired ONLY in PostgresSink via the Drizzle target's `onAfterRollback({tx,cursor})` callback (fires after the snapshot is rolled back to the new common ancestor): `to = cursor.number` is AUTHORITATIVE; `from`/`depth` are BEST-EFFORT — `from` is the highest block the run had processed (tracked from progress dispatch) and `depth = from - to` (collapsing to to/0 when unknown). The SDK callback payload is a single BlockCursor (only `.number`), so the pre-fork head is NOT exposed by the SDK — do not claim an exact reorg depth. MemorySink dispatches no reorg.

## Config & identity
- Tracked-variable names must be UNIQUE within one config: resolveConfig rejects a duplicate `variable` with ConfigError(CONFIG_DUPLICATE_VARIABLE) — two specs sharing a name would otherwise silently overwrite each other in pipeline `decoders.set(p.variable, …)` (and collide in scalarSlots/mapByTopic), so the chokepoint refuses them up front.
- validation.ts is the SINGLE SOURCE OF TRUTH for static input rules: resolveConfig's throw-path runs `validateBuilderInput({address,portalUrl,deployBlock,range,trackedVariables})` and throws the FIRST Problem as ConfigError(message, code) BEFORE any network/DB — the validator's codes mirror the ConfigError codes 1:1 (CONFIG_NO_ADDRESS/INVALID_ADDRESS/NO_PORTAL/INVALID_PORTAL_URL/NO_DEPLOY_BLOCK/INVALID_DEPLOY_BLOCK/INVALID_RANGE/NO_TRACKED_VARS/DUPLICATE_VARIABLE/MISSING_KEY_SOURCES/KEY_TUPLE_ARITY). Do NOT re-implement these checks inline in config.ts — change them in validation.ts so both the report-path and throw-path stay aligned.
- The builder keeps its OWN fail-fast guards for missing portal/deploy (CONFIG_NO_PORTAL/CONFIG_NO_DEPLOY_BLOCK) in resolve() so those surface before delegating to resolveConfig; the range to validate is threaded as resolveConfig's optional 3rd arg (so from≥deployBlock & from≤to are enforced eagerly at run/collect time, not just by .validate()).
- `.validate(range?)` returns ALL Problems without throwing or running (pre-run inspection, field-ordered); `.getConfig()` returns a read-only BuilderConfigView (id/address/portalUrl/deployBlock/trackedVariable-NAMES/hasSink) without throwing — neither performs I/O; messages/codes match the validator so message-regex tests keep matching (the duplicate-rejection test now supplies keySources so DUPLICATE, not MISSING_KEY_SOURCES, is the first Problem).
- Resume/cursor is keyed on config `id` (defaults to the lowercased address); two runs sharing an id share AND overwrite each other's cursor — index the same contract with different variable sets only under distinct `.withId(...)`.
- The indexed `address` is the storage-bearing account: for proxied tokens that is the PROXY address (where the storage actually lives), not the implementation.

## Persistence & dedup
- Every table has a compound PRIMARY KEY and all inserts are ON CONFLICT DO NOTHING, so multiple writes to the same slot within one (blockNumber, transactionIndex) collapse to a single row (first write wins) — diffs are PK'd by (contract, slot, block, txIndex), not by logIndex.
- Absent mapping keys are stored as '' (empty string) to keep PK columns NOT NULL — scalars always use key1=key2='', so a mapping key must never legitimately be the empty string or it collides with a scalar row.
- PostgresSink.onStart writes scalar slot_label rows via the PARAMETERIZED Drizzle path (`db.insert(slotLabel).values([...]).onConflictDoNothing()`), NOT string-interpolated SQL — a variable name with quotes/special chars can't break or inject the statement. Keep onStart and onData on the same insert path; never reintroduce `INSERT ... VALUES ('${...}')`.

## Build & dependencies
- resilience.ts MUST NOT import errors.ts: classification stays code/status-based so the two layers don't couple; fatality of library errors falls out of default-deny, not from type checks.
- ContractStateError.cause is declared with `declare readonly cause?` (NOT a plain field): under useDefineForClassFields a plain field would materialize an own `cause: undefined`, making `'cause' in err` true even when none was passed — keep `declare` so the property is genuinely absent unless a cause is provided.
- drizzle-orm must resolve to ONE deduped install shared with @subsquid/pipes (declared as its peer); that shared type identity is what lets sink.ts pass db/tables to drizzleTarget with no casts — a second copy breaks the boundary.
- `solc` is an OPTIONAL, lazily-imported peer needed only on the source-derivation path (derived()/fromSource); inline scalar()/mapping() shapes never load it. A non-bundled solcVersion is fetched and cached under ./.solc-cache via setupMethods (not loadRemoteVersion).

## Workarounds (remove later)
- stateDiff `prev`/`next` are valid Portal fields missing from the SDK selection type, so query.ts casts the field selection with `as any` — drop the cast once the SDK type includes them.

## Cross-path consistency
- oracle.ts verifies against chain using the EXACT same slot derivation (mappingSlot/scalarSlot) and decodeWord as the indexer, so ground-truth checks cannot drift from indexed values — keep them sharing slots.ts/decode.ts.
