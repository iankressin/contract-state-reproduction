# state-repro — EVM contract historical state reproduction

Reproduces the full historical **storage state** of an Ethereum contract into an
**append-only Postgres** database, using the [Subsquid Pipes SDK](../pipes-sdk).

Given a contract address, its source (to derive the storage layout), a deployment block,
and which variables to track, it streams every storage-slot change over the contract's life
and lets you answer **"what was the value of variable/slot X at block N?"** — e.g. any
ERC-20 holder's balance, a token's total supply, or an allowance, at any past block.

## How it works

```
resolvePlans (solc / shape) ─> decode plans: scalar | struct-fields | mapping | nested
                                     │
indexState(config, sink):           │  slot derivation (keccak for mappings, offset for packed)
  buildStateQuery(plans) ─> evmPortalStream (state diffs + key-bearing events)
  sink.consume(stream) ─> processBatch(blocks) ─> RowBatch ─> StateSink
                                                               ├─ PostgresSink (Drizzle target: DDL from schema, reorg, cursor)
                                                               └─ MemorySink   (collect rows — tests & bounded runs)
  tables:  state_log (raw diffs) │ slot_label (slot→var,keys) │ state_value (decoded)
```

- **Seams:** the **source** (`evmPortalStream`) and the **sink** (`StateSink`: `PostgresSink`
  or `MemorySink`) are the two interfaces; `indexState` wires plan resolution → query
  (`buildStateQuery`) → the pure `processBatch` transform between them. Tests drive the whole
  path with `MemorySink` (no DB/network).
- **State diffs** are the authoritative source: each carries the slot's absolute `next`
  value (not a delta) at a block/tx — so reconstruction is exact and needs no replay. They go
  into `state_log` for **any** slot the contract touches (fully generic).
- A tracked variable resolves into **plan(s)**: a *scalar* at a fixed slot (+offset), a
  *struct* expanded to one field per member, or a *mapping* (single/nested) with key + value types.
- **Scalars / struct fields** decode whenever their slot changes — no events needed; a packed
  slot can host several fields. **Mappings** need their keys from events (`keySources`).
- Decoded values land in `state_value` (numeric in `value_num`; address/bytesN in `value_hex`).
- Reorgs roll back automatically (Drizzle snapshot triggers); the cursor is persisted, so the
  indexer resumes where it left off. The table DDL is generated from the Drizzle defs
  (`createTablesSql`) — one source of truth.

## Decoded shapes supported

| Shape | Example | Keys from |
|---|---|---|
| Scalar value type (uint/int/bool/address/bytesN, with packing offset) | `totalSupply`, `owner`, `paused` | — (fixed slot) |
| Packed-struct field(s) — track the struct (all members) or `struct.member` | Uniswap V3 `slot0` → `slot0.sqrtPriceX96`, `slot0.tick` | — (fixed slot) |
| `mapping(K => V)`, value-type K | `balanceOf` | one event arg per key |
| `mapping(K1 => mapping(K2 => V))` (depth ≤ 2) | `allowance` | a tuple of event args |

`V` and `K` may be `uintN`, `intN`, `address`, `bool`, or `bytesN`. A struct expands to one
decoded field per value-type member (several fields can share one packed slot). Anything else
(dynamic arrays, `string`/`bytes`, nested-struct members, mapping depth > 2) is still captured
raw in `state_log`, just not decoded into `state_value`.

## Prerequisites

[bun](https://bun.sh) (the SDK targets bun), Docker (Postgres), and the sibling `../pipes-sdk`
checkout built (`dist/` present — `@subsquid/pipes` is `file:`-linked from it).

## Setup & run

```bash
bun install
cp .env.example .env             # DB_URL, PORTAL_URL, RPC_URL (RPC only used by verify)
docker compose up -d             # Postgres on :5432

bun run start                    # backfill deploy→head, then follow live
FROM_BLOCK=25178077 TO_BLOCK=25182077 bun run start   # bounded window (testing)
```

## Verification

| Step | Command | Checks |
|------|---------|--------|
| **1. Portal serves state diffs** | `bun run smoke` | storage diffs arrive for a contract over a range |
| **2. Layout → plans + slot math** | `bun run scripts/verify-layout.ts` | solc-js derives scalar/mapping/nested plans; `mappingSlot` == `keccak256(abi.encode(...))` |
| **3. Values match chain** | `bun run verify` | reconstructed scalar/mapping/nested values == on-chain `eth_getStorageAt` **and** the contract's accessor at the last indexed block |

The committed example (DAI, a 4000-block window) verified end-to-end: **17/17 checks matched
on-chain state** across `totalSupply` (scalar), `balanceOf` (mapping), and `allowance`
(nested mapping), and point-in-time queries at intermediate blocks matched too.

## Testing

Automated tests run with **`bun test`** (no extra deps):

```bash
bun test                  # unit + deterministic pipeline integration (offline, no infra)
bun run test:cov          # same, with a coverage report
docker compose up -d && bun run test:e2e    # gated live e2e (Postgres + Portal + RPC)
RUN_NET=1 bun test tests/unit/layout.test.ts   # also exercise the remote-solc download path
```

- **Unit** (`tests/unit/`) — covers every `src/` function: slot math (`slots`), value decoding
  (`decode`), event parsing (`events`), layout/plan resolution incl. struct descent (`layout`),
  config (`config`), DDL generation + table shapes (`schema`), the Portal query (`query`), and
  the `MemorySink` seam fed a fixture stream (`sink`).
- **Pipeline integration** (`tests/integration/pipeline.test.ts`) — drives the pure
  `buildTrackingContext` + `processBatch` core (`src/pipeline.ts`) with hand-built block
  fixtures, asserting scalar / mapping / nested-mapping output deterministically.
- **Live, gated by `RUN_E2E=1`** — `e2e.test.ts` indexes a DAI window through `indexState` +
  `PostgresSink`; `uniswap.test.ts` reconstructs a Uniswap V3 pool's `slot0.sqrtPriceX96` +
  `slot0.tick` (two packed fields of one slot) via `indexState` + `MemorySink`. Both cross-check
  against the chain through the shared `oracle` (`getStorageAt`+decode) + the contract accessors.

Default `bun test` is fully offline/deterministic (CI-friendly). The only `src/` code not
covered offline is `PostgresSink` (needs Postgres — `RUN_E2E`) and `layout.ts`'s remote-solc
download path (needs network — `RUN_NET=1`).

## Querying

`state_value` is append-only (one row per change), so a value at block N is the latest row
at or before N. Absent mapping keys use `''`.

```sql
-- balance of a holder at block N
SELECT value_num FROM state_value
WHERE contract=$1 AND variable='balanceOf' AND key1=$holder AND "blockNumber"<=$N
ORDER BY "blockNumber" DESC, "transactionIndex" DESC LIMIT 1;

-- total supply at block N (scalar: keys are '')
SELECT value_num FROM state_value
WHERE contract=$1 AND variable='totalSupply' AND "blockNumber"<=$N
ORDER BY "blockNumber" DESC LIMIT 1;

-- allowance(owner, spender) at block N (nested: key1=owner, key2=spender)
SELECT value_num FROM state_value
WHERE contract=$1 AND variable='allowance' AND key1=$owner AND key2=$spender AND "blockNumber"<=$N
ORDER BY "blockNumber" DESC, "transactionIndex" DESC LIMIT 1;
```

The same pattern over `state_log(slot)` answers the generic "value of any slot at block N".

## Configuring a contract

Edit `state-repro.config.ts`. Each tracked variable is a scalar, struct, or mapping; its shape
is derived from `source` via solc, or pinned inline with `shape`:

```ts
{
  id: 'my-token',
  address: '0x…',                  // storage location (the PROXY address, for proxied tokens)
  deployBlock: 1234567,
  source: { path: 'contracts/Token.sol', contractName: 'Token', solcVersion: '0.8.20' },
  trackedVariables: [
    { variable: 'totalSupply' },   // scalar — shape from solc; no key source
    { variable: '_balances',       // mapping — keys from Transfer
      keySources: [{ eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
                     keyTuples: [['from'], ['to']] }] },
    { variable: '_allowances',     // nested mapping — one tuple of two args per slot
      keySources: [{ eventAbi: 'event Approval(address indexed owner, address indexed spender, uint256 value)',
                     keyTuples: [['owner', 'spender']] }] },
  ],
}
```

Notes:
- **Inline shape** (when solc can't/shouldn't derive it — proxies, solc < 0.5.13, no source):
  `shape: { slot, keyTypes?: ['address',…], valueType: 'uint256', offset? }`. The committed
  DAI config uses this (solc 0.5.12 predates `storageLayout`).
- **Structs:** name the struct (`slot0`) to track all its value-type members as `slot0.<member>`,
  or use a dotted path (`slot0.sqrtPriceX96`) for one. Needs `source`, or pin each field with a
  `shape` (`{ slot, offset, valueType }`) — several fields may share one slot.
- **Proxies:** `address` is where storage lives (the proxy); `source` is the implementation.
- **Packed flags** (e.g. USDC v2.2 stores a blacklist bit in bit 255 of the balance word):
  `decodeBits: 255` masks the value.
- Mapping keys are discovered from events — a mapping write with no matching event stays
  raw-only in `state_log`.

## Known caveats / follow-ups

- **bun + solc:** `solc.loadRemoteVersion` is incompatible with bun, so `layout.ts` downloads
  the `soljson` compiler itself (cached in `.solc-cache/`) and loads it via `setupMethods`.
- **Dual drizzle-orm:** because `@subsquid/pipes` is `file:`-linked from a sibling repo, its
  `drizzle-orm` is a physically separate install from ours. Same version, and drizzle uses
  global `Symbol.for` keys, so it's correct at runtime; `sink.ts` casts away the cross-install
  *type* identity at the Drizzle-target boundary.
- **Decode scope:** value types (uint/int/bool/address/bytesN) for scalars (with packing
  offset), packed-struct fields (track the struct or a dotted member), and single/nested (≤2)
  value-typed mappings. `bytesN` packing assumes offset 0. Dynamic arrays/`bytes`/`string`,
  nested-struct members, and mapping depth > 2 remain raw in `state_log`.
