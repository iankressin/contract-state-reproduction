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

## Reorg & failure handling
- Reorg rollback exists ONLY in PostgresSink's Drizzle target (PK-keyed snapshot triggers); MemorySink does NO rollback, so it must stay bounded — collect() requires a `to` block and unbounded follow needs a PostgresSink.

## Config & identity
- Resume/cursor is keyed on config `id` (defaults to the lowercased address); two runs sharing an id share AND overwrite each other's cursor — index the same contract with different variable sets only under distinct `.withId(...)`.
- The indexed `address` is the storage-bearing account: for proxied tokens that is the PROXY address (where the storage actually lives), not the implementation.

## Persistence & dedup
- Every table has a compound PRIMARY KEY and all inserts are ON CONFLICT DO NOTHING, so multiple writes to the same slot within one (blockNumber, transactionIndex) collapse to a single row (first write wins) — diffs are PK'd by (contract, slot, block, txIndex), not by logIndex.
- Absent mapping keys are stored as '' (empty string) to keep PK columns NOT NULL — scalars always use key1=key2='', so a mapping key must never legitimately be the empty string or it collides with a scalar row.

## Build & dependencies
- drizzle-orm must resolve to ONE deduped install shared with @subsquid/pipes (declared as its peer); that shared type identity is what lets sink.ts pass db/tables to drizzleTarget with no casts — a second copy breaks the boundary.
- `solc` is an OPTIONAL, lazily-imported peer needed only on the source-derivation path (derived()/fromSource); inline scalar()/mapping() shapes never load it. A non-bundled solcVersion is fetched and cached under ./.solc-cache via setupMethods (not loadRemoteVersion).

## Workarounds (remove later)
- stateDiff `prev`/`next` are valid Portal fields missing from the SDK selection type, so query.ts casts the field selection with `as any` — drop the cast once the SDK type includes them.

## Cross-path consistency
- oracle.ts verifies against chain using the EXACT same slot derivation (mappingSlot/scalarSlot) and decodeWord as the indexer, so ground-truth checks cannot drift from indexed values — keep them sharing slots.ts/decode.ts.
