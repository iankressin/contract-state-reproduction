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

## Usage (library API)

Published as **`@subsquid/contract-state`**. The whole flow is three pieces: a **config**
(which contract, which variables), `indexState`, and a **sink** (where rows land). You pass a
config + sink to `indexState` and it resolves the storage layout, streams diffs from the
Portal, and writes decoded value history.

### Install

```bash
bun add @subsquid/contract-state
```

Runs on **bun** (the underlying Pipes SDK targets bun). For the Postgres sink you also need a
reachable Postgres and the Drizzle node-postgres driver to build the `db` handle:

```bash
bun add drizzle-orm pg
```

### Index into Postgres

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { resolveConfig, indexState, PostgresSink, type JobConfig } from '@subsquid/contract-state'

// DAI — exercises all three decoded shapes. solc 0.5.12 predates `storageLayout`, so the
// slots are pinned inline via `shape` (see "deriving vs pinning shapes" below).
const daiConfig: JobConfig = {
  id: 'dai-state',
  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  deployBlock: 8_928_674,
  // toBlock omitted => backfill to head, then follow the chain live.
  trackedVariables: [
    { variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } },
    {
      variable: 'balanceOf',
      shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' },
      keySources: [{ eventAbi: 'event Transfer(address indexed src, address indexed dst, uint256 wad)', keyTuples: [['src'], ['dst']] }],
    },
    {
      variable: 'allowance',
      shape: { slot: 3, keyTypes: ['address', 'address'], valueType: 'uint256' },
      keySources: [{ eventAbi: 'event Approval(address indexed src, address indexed guy, uint256 wad)', keyTuples: [['src', 'guy']] }],
    },
  ],
}

// PORTAL_URL selects the dataset (defaults to Ethereum mainnet); DB_URL points at Postgres.
const db = drizzle(process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres')

// PostgresSink creates its tables on first run and persists a cursor (resumable) and rolls
// back reorgs automatically. Backfills deployBlock -> head, then follows live.
await indexState(resolveConfig(daiConfig), new PostgresSink(db))
```

`resolveConfig` validates/normalizes the config and reads `PORTAL_URL` from the environment
(falling back to `https://portal.sqd.dev/datasets/ethereum-mainnet`). To index another chain,
point `PORTAL_URL` at that dataset.

### Bounded range (point-in-time backfill)

Pass an explicit `{ from, to }` to `indexState` to index a finite window instead of following
live — useful for tests, reproductions, and one-off reconstructions:

```ts
await indexState(resolveConfig(daiConfig), new PostgresSink(db), { from: 8_928_674, to: 8_932_674 })
```

### Index into memory (no database)

`MemorySink` collects rows in memory — no Postgres, no Drizzle. Ideal for tests, scripts, and
bounded reconstructions. It does **no** reorg rollback, so use it for finite ranges, not an
unbounded live follow.

```ts
import { resolveConfig, indexState, MemorySink } from '@subsquid/contract-state'

const sink = new MemorySink()
await indexState(resolveConfig(daiConfig), sink, { from: 8_928_674, to: 8_932_674 })

// sink.rows = { stateRows, labelRows, valueRows }. One valueRow per decoded change:
for (const v of sink.rows.valueRows) {
  // v.variable, v.key1, v.key2, v.valueNum (bigint | null), v.valueHex (string | null), v.blockNumber
  console.log(v.variable, v.key1, v.key2, v.valueNum ?? v.valueHex, '@', v.blockNumber)
}
```

### Deriving shapes from source vs pinning them inline

Each tracked variable's shape (slot + key/value types) is either derived from Solidity source
via solc, or pinned inline — and the choice decides whether you ship any `.sol` files at all:

```ts
// (a) Derive from source — omit `shape`, provide `source`. The .sol file must exist on disk
//     (resolved from process.cwd()); the pinned solc version is downloaded and cached under
//     .solc-cache/. Works for solc >= 0.5.13 (when storageLayout output was added).
const derived: JobConfig = {
  id: 'my-token', address: '0x…', deployBlock: 1_234_567,
  source: { path: 'contracts/Token.sol', contractName: 'Token', solcVersion: '0.8.20' },
  trackedVariables: [{ variable: 'totalSupply' }, /* … */],
}

// (b) Pin every shape inline and omit `source` entirely — no solc, no source files needed.
const pinned: JobConfig = {
  id: 'my-token', address: '0x…', deployBlock: 1_234_567,
  trackedVariables: [{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }],
}
```

See [Configuring a contract](#configuring-a-contract) below for the full field reference
(proxies, structs, packed flags, nested mappings).

### Custom sink

`indexState`'s second argument is any `StateSink`. Implement the one-method interface to route
rows anywhere — `processBatch` turns each streamed block batch into the same row sets the
built-in sinks persist:

```ts
import {
  indexState, resolveConfig, processBatch,
  type StateSink, type BlockStream, type TrackingContext,
} from '@subsquid/contract-state'

class MySink implements StateSink {
  async consume(stream: BlockStream, tracking: TrackingContext): Promise<void> {
    for await (const { data } of stream) {
      const { stateRows, labelRows, valueRows } = processBatch(tracking, data)
      // persist however you like — file, queue, another DB …
    }
  }
}

await indexState(resolveConfig(daiConfig), new MySink(), { from: 8_928_674, to: 8_932_674 })
```

### Reading values back

For `PostgresSink`, query `state_value` / `state_log` directly — see [Querying](#querying). For
`MemorySink`, read `sink.rows` (a value at block N is the latest `valueRow` at or before N for
that `variable` + `key1`/`key2`).

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
