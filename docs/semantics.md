# State semantics — the temporal / row contract

This document formalizes exactly what a row in `state_value` (and `state_log`) *means* in
time, so that "the value of variable/slot X at block N" has one unambiguous answer. The
querying recipes in the [README](../README.md#querying) all follow from this contract.

It mirrors the binding invariant recorded under **Data model** in
[`docs/context/invariants.md`](./context/invariants.md) (the `state_value` append-only line);
that ledger is the source of truth — this doc is the prose expansion. Do not let them drift.

## The append-only, event-sourced model

`state_value` (decoded values) and `state_log` (raw slot diffs) are **append-only event
logs, not snapshots**. The library writes **one row per storage write**: each time a tracked
slot's value changes at some `(blockNumber, transactionIndex)`, exactly one row is appended
carrying the slot's new absolute value at that point. State diffs from the Portal already
carry the slot's absolute `next` value (not a delta), so reconstruction is exact and needs no
replay.

Two consequences follow directly, and they are the whole contract:

1. **There is NO row on blocks where the slot did not change.** The history is sparse: a
   variable that was set once at block 1000 and never touched again has a single row at block
   1000, and nothing afterward — even though its value logically persists forever.

2. **The value at block N is the value carried by the latest row at or before N.** Formally:

   > The value of a variable (or raw slot) at block `N` is the `value_*` of the row with the
   > greatest `blockNumber ≤ N` for that key — i.e. the most recent write that happened at or
   > before block `N`. Within a single block, ties break on `transactionIndex` (and, for raw
   > slots, the write order the diffs arrived in), with the latest winning.

If no such row exists (no write to that key at or before `N`), the value is the type's
zero/default — the slot was never written, so on-chain it reads as zero.

## Key columns: how scalars and mappings are addressed

Every decoded row is addressed by `(contract, variable, key1, key2)`. Because the primary-key
columns must be `NOT NULL`, absence is encoded as the **empty string**, not `NULL`:

- **Scalars** (and struct fields like `slot0.tick`) have no mapping keys, so they always use
  `key1 = key2 = ''`.
- **Single mappings** (`mapping(K => V)`, e.g. `balanceOf`) put the key in `key1` and leave
  `key2 = ''`.
- **Nested mappings** (`mapping(K1 => mapping(K2 => V))`, depth ≤ 2, e.g. `allowance`) use
  `key1 = K1`, `key2 = K2`.

Because absent keys are stored as `''`, **a real mapping key must never legitimately be the
empty string** — it would collide with the scalar/absent encoding. (Addresses, the usual
keys, are `0x`-prefixed, so this never happens in practice.)

A mapping write is only **decoded** into `state_value` when the key was discovered from an
event in the same batch (see `.keysFrom(...)`); a mapping write whose key was never seen in a
matching event stays **raw-only** in `state_log` — captured, just not labeled with a
human-readable key.

## SQL recipe: "value at block N"

The shape is always the same — filter to the key, restrict to `blockNumber ≤ N`, order
newest-first, take the first row:

```sql
-- Generic shape: latest write at or before block N for one addressed value.
SELECT value_num, value_hex
FROM state_value
WHERE contract = $contract
  AND variable = $variable
  AND key1 = $key1            -- '' for a scalar
  AND key2 = $key2            -- '' for a scalar or a single-key mapping
  AND "blockNumber" <= $N
ORDER BY "blockNumber" DESC, "transactionIndex" DESC
LIMIT 1;
```

Concretely:

```sql
-- Scalar (totalSupply) at block N — keys are ''.
SELECT value_num FROM state_value
WHERE contract = $1 AND variable = 'totalSupply' AND "blockNumber" <= $N
ORDER BY "blockNumber" DESC LIMIT 1;

-- Single mapping (balanceOf[holder]) at block N.
SELECT value_num FROM state_value
WHERE contract = $1 AND variable = 'balanceOf' AND key1 = $holder AND "blockNumber" <= $N
ORDER BY "blockNumber" DESC, "transactionIndex" DESC LIMIT 1;

-- Nested mapping (allowance[owner][spender]) at block N.
SELECT value_num FROM state_value
WHERE contract = $1 AND variable = 'allowance' AND key1 = $owner AND key2 = $spender
  AND "blockNumber" <= $N
ORDER BY "blockNumber" DESC, "transactionIndex" DESC LIMIT 1;
```

A `NULL`/empty result means "never written at or before N" ⇒ treat as the type's zero value.

Decoded numeric values land in `value_num`; address/`bytesN` values land in `value_hex`.

The **same pattern over `state_log(slot)`** answers the fully generic "value of *any* slot at
block N", since `state_log` records the raw absolute word for every slot the contract touched:

```sql
SELECT value FROM state_log
WHERE contract = $1 AND slot = $slot AND "blockNumber" <= $N
ORDER BY "blockNumber" DESC, "transactionIndex" DESC LIMIT 1;
```

## In-memory (`.collect()` / `MemorySink`)

The contract is identical without a database: `.collect(range)` returns `valueRows`, and the
value at block N is the latest `valueRow` at or before N for that `variable` + `key1`/`key2`,
applying the same tie-break. `MemorySink` does no reorg rollback, so it must stay bounded —
for a live follow that needs reorg-correct history, use `PostgresSink`.
