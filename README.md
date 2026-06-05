# @iankressin/contract-state — EVM contract historical state reproduction

[![npm version](https://img.shields.io/npm/v/@iankressin/contract-state)](https://www.npmjs.com/package/@iankressin/contract-state)
[![CI](https://github.com/iankressin/contract-state-reproduction/actions/workflows/ci.yml/badge.svg)](https://github.com/iankressin/contract-state-reproduction/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Reproduces the full historical **storage state** of an Ethereum contract into an
**append-only Postgres** database (or memory), using the [Subsquid Pipes SDK](https://www.npmjs.com/package/@subsquid/pipes).

Given a contract address, a deployment block, and which variables to track (with their storage
shapes), it streams every storage-slot change over the contract's life and lets you answer
**"what was the value of variable/slot X at block N?"** — e.g. any ERC-20 holder's balance, a
token's total supply, or an allowance, at any past block.

**Works on any EVM chain.** Nothing here is Ethereum-mainnet-specific: storage slots, state
diffs, and the decode model are identical across EVM networks. You select the chain purely by
pointing `.onPortal(url)` at that chain's [SQD Portal](https://docs.sqd.ai) dataset URL — e.g.
`…/datasets/ethereum-mainnet`, `…/datasets/base-mainnet`, `…/datasets/arbitrum-one`. To index a
different chain, change only that URL; the contract address, shapes, and queries are the same.

```ts
import { ContractState, PostgresSink, mapping, scalar } from '@iankressin/contract-state'

await ContractState.forContract('0x6B175474E89094C44Da98b954EedeAC495271d0F') // DAI
  .onPortal('https://portal.sqd.dev/datasets/ethereum-mainnet')
  .deployedAt(8_928_674)
  .track(scalar('totalSupply', { slot: 1, type: 'uint256' }))
  .track(
    mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' }).keysFrom(
      'event Transfer(address indexed src, address indexed dst, uint256 wad)',
      [['src'], ['dst']],
    ),
  )
  .into(PostgresSink.fromConnectionString(process.env.DB_URL!))
  .run() // backfill deploy → head, then follow live
```

## How it works

```
ContractState.forContract(addr)          ← explicit, code-first config (no env, no config files)
  .onPortal(url).deployedAt(block)
  .track(scalar | mapping | derived)
  .into(sink).run(range?):
       resolvePlans (inline shape / solc) ─> decode plans: scalar | struct-fields | mapping | nested
                                     │           slot derivation (keccak for mappings, offset for packed)
       buildStateQuery(plans) ─> evmPortalStream (state diffs + key-bearing events)
       sink.consume(stream) ─> processBatch(blocks) ─> RowBatch ─> StateSink
                                                               ├─ PostgresSink (Drizzle: DDL, reorg, cursor)
                                                               └─ MemorySink   (collect rows — tests & bounded runs)
  tables:  state_log (raw diffs) │ slot_label (slot→var,keys) │ state_value (decoded)
```

- **The builder is a typed assembler.** It produces an internal config and hands it to the proven
  indexing engine. The **source** (`evmPortalStream`) and the **sink** (`StateSink`: `PostgresSink`
  or `MemorySink`) are the two seams; the pure `processBatch` transform sits between them.
- **State diffs** are the authoritative source: each carries the slot's absolute `next` value (not a
  delta) at a block/tx — so reconstruction is exact and needs no replay. They go into `state_log`
  for **any** slot the contract touches (fully generic).
- A tracked variable resolves into **plan(s)**: a *scalar* at a fixed slot (+offset), a *struct*
  expanded to one field per member, or a *mapping* (single/nested) with key + value types.
- **Scalars / struct fields** decode whenever their slot changes — no events needed; a packed slot
  can host several fields. **Mappings** need their keys from events (`.keysFrom(...)`).
- Decoded values land in `state_value` (numeric in `value_num`; address/bytesN in `value_hex`).
- `PostgresSink` rolls back reorgs automatically (Drizzle snapshot triggers) and persists a cursor,
  so a live run resumes where it left off. Table DDL is generated from the Drizzle defs
  (`createTablesSql`) — one source of truth.

## Decoded shapes supported

| Shape | Example | Keys from |
|---|---|---|
| Scalar value type (uint/int/bool/address/bytesN, with packing offset) | `totalSupply`, `owner`, `paused` | — (fixed slot) |
| Packed-struct field(s) — track the struct (all members) or `struct.member` | Uniswap V3 `slot0` → `slot0.sqrtPriceX96`, `slot0.tick` | — (fixed slot) |
| `mapping(K => V)`, value-type K | `balanceOf` | one event arg per key |
| `mapping(K1 => mapping(K2 => V))` (depth ≤ 2) | `allowance` | a tuple of event args |

`V` and `K` may be `uintN`, `intN`, `address`, `bool`, or `bytesN`. A struct expands to one decoded
field per value-type member (several fields can share one packed slot). Anything else (dynamic
arrays, `string`/`bytes`, nested-struct members, mapping depth > 2) is still captured raw in
`state_log`, just not decoded into `state_value`.

## Install

```bash
pnpm add @iankressin/contract-state
```

This package is **ESM-only** and ships **only** ESM + types (no CommonJS build): import it with
`import`, from an ESM module (`"type": "module"`, a `.mts` file, or native ESM) on **Node ≥ 22.15**.
There is no CJS entry, so `require('@iankressin/contract-state')` will not work — see
[FAQ / Troubleshooting](#faq--troubleshooting).

Three dependencies are **optional peers**, installed only for the paths that use them:

```bash
pnpm add drizzle-orm pg   # for PostgresSink (the Postgres target)
pnpm add solc             # only for source-derived shapes (.fromSource + derived())
```

`MemorySink` / `.collect()` need none of these.

## Usage

The whole flow is three pieces: a **contract + variables** (the builder + `scalar`/`mapping`/
`derived`), a **range** (`.run()`/`.collect()`), and a **sink** (where rows land).

### Index into Postgres

`PostgresSink` creates its tables on first run, persists a cursor (resumable), and rolls back
reorgs automatically. `fromConnectionString` builds the Drizzle handle for you — you never import
`drizzle-orm` yourself.

```ts
import { ContractState, PostgresSink, mapping, scalar } from '@iankressin/contract-state'

await ContractState.forContract('0x6B175474E89094C44Da98b954EedeAC495271d0F')
  .onPortal('https://portal.sqd.dev/datasets/ethereum-mainnet')
  .deployedAt(8_928_674)
  .track(scalar('totalSupply', { slot: 1, type: 'uint256' }))
  .track(
    mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' }).keysFrom(
      'event Transfer(address indexed src, address indexed dst, uint256 wad)',
      [['src'], ['dst']],
    ),
  )
  .track(
    mapping('allowance', { slot: 3, keys: ['address', 'address'], value: 'uint256' }).keysFrom(
      'event Approval(address indexed src, address indexed guy, uint256 wad)',
      [['src', 'guy']],
    ),
  )
  .into(PostgresSink.fromConnectionString(process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'))
  .run() // omit the range to backfill deploy → head, then follow the chain live
```

`.onPortal(url)` selects the dataset (and therefore the chain) — it is explicit, with no environment
fallback. To index another chain, point it at that dataset's Portal URL.

If you already have a Drizzle `node-postgres` handle (e.g. a shared pool), pass it directly:
`new PostgresSink(db)`.

### Bounded range, or straight into memory

Pass `{ from, to }` to `.run()` for a finite window. Or use `.collect({ from, to })` to index into
memory and get the rows back directly — no database, no Drizzle — ideal for tests, scripts, and
one-off reconstructions:

```ts
import { ContractState, scalar } from '@iankressin/contract-state'

const { valueRows } = await ContractState.forContract('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')
  .onPortal('https://portal.sqd.dev/datasets/ethereum-mainnet')
  .deployedAt(0)
  // Two fields packed into slot 0 of a Uniswap V3 pool's Slot0 struct:
  .track(scalar('slot0.sqrtPriceX96', { slot: 0, offset: 0, type: 'uint160' }))
  .track(scalar('slot0.tick', { slot: 0, offset: 20, type: 'int24' }))
  .collect({ from: 22_400_000, to: 22_400_050 })

// One valueRow per decoded change:
for (const v of valueRows) {
  console.log(v.variable, v.key1, v.key2, v.valueNum ?? v.valueHex, '@', v.blockNumber)
}
```

`.collect()` requires a bounded range (a `to`): `MemorySink` buffers everything and does no reorg
rollback, so it must not follow the chain unbounded. For a live follow, use `.into(PostgresSink…).run()`.

### Deriving shapes from source vs pinning them inline

Each tracked variable's shape (slot + key/value types) is either **pinned inline** via
`scalar()`/`mapping()`, or **derived from Solidity source** via solc with `derived()` + `.fromSource()`:

```ts
// (a) Pin inline — no source, no solc. Best for proxies, solc < 0.5.13, or when you know the layout.
await ContractState.forContract('0x…')
  .onPortal(PORTAL).deployedAt(1_234_567)
  .track(scalar('totalSupply', { slot: 1, type: 'uint256' }))
  .into(sink).run()

// (b) Derive from source — install the optional `solc` peer, point at the .sol file. The kind
//     (scalar / mapping / struct) is auto-detected; solc >= 0.5.13 (when storageLayout was added).
import { ContractState, derived } from '@iankressin/contract-state'

await ContractState.forContract('0x…')
  .onPortal(PORTAL).deployedAt(1_234_567)
  .fromSource({ path: 'contracts/Token.sol', contractName: 'Token', solcVersion: '0.8.20' })
  .track(derived('totalSupply')) // scalar — auto-detected
  .track(derived('_balances').keysFrom('event Transfer(address indexed from, address indexed to, uint256 value)', [['from'], ['to']]))
  .into(sink).run()
```

The `.sol` file is resolved from `process.cwd()`; a pinned solc version is downloaded and cached
under `.solc-cache/`.

### Custom sink

`.into()` accepts any `StateSink`. Implement the one-method interface to route rows anywhere —
`processBatch` turns each streamed block batch into the same row sets the built-in sinks persist:

```ts
import { processBatch, type StateSink, type BlockStream, type TrackingContext } from '@iankressin/contract-state'

class MySink implements StateSink {
  async consume(stream: BlockStream, tracking: TrackingContext): Promise<void> {
    for await (const { data } of stream) {
      const { stateRows, labelRows, valueRows } = processBatch(tracking, data)
      // persist however you like — a file, a queue, another DB …
    }
  }
}
```

### Reading values back

For `PostgresSink`, query `state_value` / `state_log` directly — see [Querying](#querying). For
`.collect()` / `MemorySink`, read the returned rows (a value at block N is the latest `valueRow`
at or before N for that `variable` + `key1`/`key2`).

## API reference

**Builder** — `ContractState.forContract(address)` returns a chainable builder:

| Method | Purpose |
|---|---|
| `.onPortal(url)` | **Required.** Portal dataset URL (selects the chain). No env fallback. |
| `.deployedAt(block)` | **Required.** Deploy block; the default start of the indexed range. |
| `.track(...specs)` | Add tracked variables (`scalar`/`mapping`/`derived`). Repeatable; varargs. |
| `.fromSource({ path, contractName, solcVersion?, optimizer?, evmVersion? })` | Source for `derived(...)` shapes. |
| `.withId(id)` | Cursor key for resumable Postgres runs. Defaults to the lowercased address. |
| `.into(sink)` | `PostgresSink`, `MemorySink`, or a custom `StateSink`. |
| `.run(range?)` | Terminal. No range ⇒ backfill → live; `{ from, to }` ⇒ bounded window. |
| `.collect(range)` | Terminal. Bounded-only; returns `{ stateRows, labelRows, valueRows }` from memory. |

**Track-spec helpers:**

| Helper | Maps to |
|---|---|
| `scalar(name, { slot, offset?, type, bits? })` | a fixed-slot scalar (or `'struct.member'` packed field) |
| `mapping(name, { slot, keys, value, bits? })` | a single/nested mapping; chain `.keysFrom(...)` |
| `derived(name)` | a solc-derived variable (needs `.fromSource`); chain `.keysFrom(...)` if it's a mapping |
| `.keysFrom(eventAbi, keyPaths)` | bind the event(s) carrying a mapping's keys; repeatable |

`keyPaths` is a list of key-paths; each path's length must equal the mapping depth — e.g.
`balanceOf`: `[['src'], ['dst']]` (two single-key paths), `allowance`: `[['src', 'guy']]` (one
two-key path). `bits` masks the low bits of the decoded value (e.g. `255` for USDC v2.2's packed flag).

**Sinks:** `PostgresSink.fromConnectionString(url)`, `new PostgresSink(db)`, `new MemorySink()`.
**Schema (for querying):** `stateLog`, `slotLabel`, `stateValue`, `allTables`, `createTablesSql`.

### Run options, errors, validation & cursors

These are the pieces beyond the core builder. The full surface is in the
[Typedoc API docs](https://typedoc.org) (`pnpm docs:api` → `docs/api/`); this is the tight version.

**`.run(range?, opts?)` / `.collect(range, opts?)` options** — a `RunOptions` bag, all optional;
the defaults preserve the resilient behavior:

| Field | Type | Purpose |
|---|---|---|
| `strict` | `boolean` | `true` ⇒ a decode anomaly throws `DecodingError`; `false` (default) ⇒ warn + `stats.droppedLogs++` and continue. |
| `retry` | `RetryPolicy` | Backoff tuning for transient infra faults (`maxAttempts` 5, `baseMs` 250, `maxMs` 30_000, `factor` 2, `jitter` 1; `isRetryable` is default-deny). |
| `signal` | `AbortSignal` | Cancel an in-flight run; it stops at the next batch boundary and **resolves cleanly** with partial results. |
| `logger` | `Logger` | Inject a logger (e.g. `createLogger('debug')` or `createLogger('silent')`); defaults to the library's pino logger at `info`. |
| `onProgress` | `(p: { from; to; rows }) => void` | Per-range progress (after Stats are bumped). |
| `onError` | `(err: unknown) => void` | Each error encountered (whether or not it's rethrown). |
| `onReorg` | `(info: ReorgInfo) => void` | A chain reorg was detected and rolled back (PostgresSink only). |

**Typed errors** — every error the library throws on purpose is a `ContractStateError` subclass
carrying a stable, machine-readable `code` (SCREAMING_SNAKE). Catch the base and branch on `.code`
(never on message text):

```ts
import { ContractStateError, ConfigError } from '@iankressin/contract-state'

try {
  await ContractState.forContract(addr)./* … */.run()
} catch (e) {
  if (e instanceof ContractStateError) console.error(e.code, e.message) // e.g. 'CONFIG_NO_PORTAL'
  else throw e
}
```

| Class | Code prefix | When |
|---|---|---|
| `ConfigError` | `CONFIG_*` | User-fixable config/input (bad address, missing portal/sink/deploy block, unbounded `collect`, duplicate variable, `keysFrom` arity, solc not installed / version not found, …). |
| `LayoutError` | `LAYOUT_*` | Storage-layout / solc-compile failures. |
| `DecodingError` | `DECODE_*` | Decode-time failures (only thrown under `{ strict: true }`; otherwise warned + counted). |
| `SinkError` | `SINK_*` | Sink/persistence failures (DB write, connection). |
| `PortalError` | `PORTAL_*` | Failures talking to the Portal / upstream source. |

**Inspect without running** — both are pure (no I/O), so you can validate a builder before a run:

- `.validate(range?)` → `Problem[]` — returns **all** input problems (field-ordered) without throwing
  or running; pass the same `range` you'll run to validate it too. Empty array ⇒ ready.
- `.getConfig()` → a read-only `BuilderConfigView` (`id`, `address`, `portalUrl`, `deployBlock`,
  `trackedVariables` names, `hasSink`) — never throws.

**Cursor (custom sinks)** — for resumable custom sinks, `Cursor` is a tiny load/save high-water-mark
interface; `MemoryCursor` is an in-memory implementation and `withCursor(stream, resumeAfter)` drops
already-processed blocks before your sink sees them. See
[`examples/custom-sink.ts`](./examples/custom-sink.ts) for the full pattern (and its reorg caveat: a
cursor is a high-water mark, not a reorg-rollback mechanism).

**Logging** — the default `Logger` is pino-backed. Build one with `createLogger(level?, destination?)`
and inject it via `RunOptions.logger`; `createLogger('silent')` disables all output.

## Querying

`state_value` is append-only (one row per change), so a value at block N is the latest row at or
before N. Absent mapping keys use `''`. This temporal/row contract — the sparse history, the
"latest row ≤ N" rule, the `key1`/`key2 = ''` encoding — is formalized in
[`docs/semantics.md`](./docs/semantics.md).

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

## Shape-authoring reference

- **Inline shape** (proxies, solc < 0.5.13, or when you know the layout): `scalar(name, { slot,
  offset?, type, bits? })` and `mapping(name, { slot, keys: ['address',…], value: 'uint256' })`.
- **Structs:** `derived('slot0')` tracks all value-type members as `slot0.<member>`; or pin each
  field with `scalar('slot0.sqrtPriceX96', { slot, offset, type })` — several fields may share one slot.
- **Proxies:** `forContract(address)` is where storage lives (the proxy); `.fromSource(...)` is the
  implementation.
- **Packed flags** (e.g. USDC v2.2 stores a blacklist bit in bit 255 of the balance word):
  `scalar('balanceOf', { …, bits: 255 })`.
- **Mapping keys** are discovered from events via `.keysFrom(...)` — a mapping write with no matching
  event stays raw-only in `state_log`.

## Prerequisites & local development

[pnpm](https://pnpm.io), Node ≥ 22.15, and Docker (for a local Postgres). This repo ships a runnable
example and a docker-compose Postgres:

```bash
pnpm install
cp .env.example .env             # DB_URL, PORTAL_URL, RPC_URL (RPC only used by verify)
pnpm db:up                       # Postgres on :5432

pnpm example                                          # backfill deploy → head, then follow live
FROM_BLOCK=25178077 TO_BLOCK=25182077 pnpm example    # bounded window (testing)
```

The example (`examples/dai.ts`) reproduces DAI with inline shapes.

## Build & publish

```bash
pnpm build          # tsup → dist/index.js (ESM) + dist/index.d.ts
pnpm typecheck      # tsc --noEmit
```

The published package ships only `dist/` (ESM + types). `prepack`/`prepublishOnly` build automatically.

## Verification

| Step | Command | Checks |
|------|---------|--------|
| **1. Portal serves state diffs** | `pnpm smoke` | storage diffs arrive for a contract over a range |
| **2. Layout → plans + slot math** | `pnpm exec tsx scripts/verify-layout.ts` | solc-js derives scalar/mapping/nested plans; `mappingSlot` == `keccak256(abi.encode(...))` |
| **3. Values match chain** | `pnpm verify` | reconstructed scalar/mapping/nested values == on-chain `eth_getStorageAt` **and** the contract's accessor at the last indexed block |

The committed example (DAI, a 4000-block window) verified end-to-end: **17/17 checks matched
on-chain state** across `totalSupply` (scalar), `balanceOf` (mapping), and `allowance` (nested
mapping), and point-in-time queries at intermediate blocks matched too.

## Testing

Tests run with **vitest**:

```bash
pnpm test                 # unit + deterministic pipeline integration (offline, no infra)
pnpm test:cov             # same, with a coverage report
pnpm db:up && pnpm test:e2e   # gated live e2e (Postgres + Portal + RPC)
pnpm test:net             # also exercise the remote-solc download path
```

- **Unit** (`tests/unit/`) — covers every `src/` function: slot math, value decoding, event parsing,
  layout/plan resolution incl. struct descent, config + the builder/track-spec mapping, DDL
  generation, the Portal query, and the `MemorySink` seam.
- **Pipeline integration** (`tests/integration/pipeline.test.ts`) — drives the pure
  `buildTrackingContext` + `processBatch` core with hand-built fixtures, deterministically.
- **Live, gated by `RUN_E2E=1`** — `e2e.test.ts` indexes a DAI window through the builder +
  `PostgresSink`; `uniswap.test.ts` reconstructs a Uniswap V3 pool's `slot0.sqrtPriceX96` +
  `slot0.tick` via the builder's `.collect()`. Both cross-check the chain through the shared `oracle`
  (`getStorageAt`+decode) + the contract accessors.

Default `pnpm test` is fully offline/deterministic (CI-friendly). The only `src/` code not covered
offline is `PostgresSink` (needs Postgres — `RUN_E2E`) and `layout.ts`'s remote-solc download path
(needs network — `pnpm test:net`).

## Known caveats

- **solc is an optional peer.** Source-derived shapes (`derived()` + `.fromSource()`) require
  installing `solc`; with only inline shapes you never need it. Remote solc versions are fetched and
  cached under `.solc-cache/` (a portable fetch + `setupMethods` path, no `loadRemoteVersion`).
- **Decode scope:** value types (uint/int/bool/address/bytesN) for scalars (with packing offset),
  packed-struct fields (track the struct or a dotted member), and single/nested (≤ 2) value-typed
  mappings. `bytesN` packing assumes offset 0. Dynamic arrays/`bytes`/`string`, nested-struct
  members, and mapping depth > 2 remain raw in `state_log`.

## FAQ / Troubleshooting

**`require('@iankressin/contract-state')` throws (`ERR_REQUIRE_ESM` / "is not a function").**
This package is **ESM-only** — it ships only an ESM build and has no CommonJS entry. Use `import`
from an ESM context (`"type": "module"` in your `package.json`, a `.mts` file, or native ESM) on
**Node ≥ 22.15**. There is no CJS interop to add; `require` cannot load it.

**`Cannot find package 'pg'` / `'drizzle-orm'` (or a missing-module error from `PostgresSink`).**
`pg` and `drizzle-orm` are **optional peers** loaded only by `PostgresSink`. Install them when you
use the Postgres target: `pnpm add drizzle-orm pg`. `MemorySink` / `.collect()` need neither.

**`solc` is reported missing.** `solc` is an optional peer needed **only** for source-derived shapes
(`derived()` + `.fromSource()`). Install it (`pnpm add solc`) for that path, or pin shapes inline with
`scalar()` / `mapping()` and you never load it. A non-bundled `solcVersion` is fetched and cached under
`.solc-cache/`.

**A log fails to decode — does the run crash?** It depends on `strict`. By **default** (resilient),
an undecodable log that matched a tracked event's topic is **warned and counted** (`logger.warn` +
`stats.droppedLogs++`) and the run continues. Pass `{ strict: true }` to `.run()` / `.collect()` and
the same anomaly throws a `DecodingError` instead. (A log whose topic matches no tracker is always
skipped quietly and does **not** count as a dropped log.)

**How do I cancel a run?** Pass an `AbortSignal` via `RunOptions.signal`. The run stops at the next
batch boundary and **resolves cleanly** (no throw) with whatever was already persisted/collected:

```ts
const ac = new AbortController()
const p = ContractState.forContract(addr)./* … */.run(undefined, { signal: ac.signal })
// later: ac.abort()  →  p resolves normally with partial progress
```

(On the PostgresSink path, cancellation can be delayed by up to ~300 ms due to the SDK's
transaction-retry wrapper; it still resolves cleanly.)

**How do I see more (or silence) the logs?** The library logs via [pino](https://getpino.io) at
`info` by default. Inject your own level/instance with `RunOptions.logger`:

```ts
import { createLogger } from '@iankressin/contract-state'

await ContractState.forContract(addr)./* … */.run(undefined, { logger: createLogger('debug') })  // verbose
await ContractState.forContract(addr)./* … */.run(undefined, { logger: createLogger('silent') }) // quiet
```

**A config mistake throws before anything runs.** Static input is validated up front and the **first**
problem is thrown as a `ConfigError` with a specific `code` (e.g. `CONFIG_NO_PORTAL`,
`CONFIG_INVALID_ADDRESS`, `CONFIG_NO_DEPLOY_BLOCK`). To see **all** problems without running, call
`.validate(range?)` → `Problem[]` (empty ⇒ ready), or `.getConfig()` for a read-only view of the
builder state. Branch on `e.code`, never on the message text.

## Migrating to 0.2.0

> _Note: `package.json` reads `0.1.0` on `main`; the `0.2.0` version is stamped at release time by Changesets, so this section may describe the next published release rather than the version you have checked out._

0.2.0 is the first hardening release and carries **breaking changes** since 0.1.0. The release
`CHANGELOG.md` (generated by Changesets at publish time) is the canonical list; the highlights:

- **Package renamed (rescope):** `@subsquid/contract-state` → **`@iankressin/contract-state`**. Update
  your install and every import specifier. Still ESM-only, Node ≥ 22.15.
- **Typed errors replace bare `Error`.** Everything the library throws on purpose is now a
  `ContractStateError` subclass — `ConfigError` / `LayoutError` / `DecodingError` / `SinkError` /
  `PortalError` — each with a stable `code`. Catch `ContractStateError` and branch on `e.code` instead
  of matching message strings.
- **`.run()` / `.collect()` take an options bag.** New signature `.run(range?, opts?)` /
  `.collect(range, opts?)` with a `RunOptions`: `strict`, `retry`, `signal`, `logger`, `onProgress`,
  `onError`, `onReorg`. All optional; omitting them preserves the previous resilient behavior.
- **New inspection methods:** `.validate(range?)` (returns all `Problem`s without running) and
  `.getConfig()` (read-only `BuilderConfigView`).
- **Structured logging:** internal `console.log` calls are gone, replaced by an injectable pino
  `Logger` (`createLogger(level?, destination?)`; default `info`, `'silent'` to disable).
- **Parameterized slot-label SQL:** `PostgresSink` writes `slot_label` rows via the parameterized
  Drizzle path (no string-interpolated `INSERT`), so a variable name with special characters can't
  break or inject the statement. No API change — purely a safety fix.

See [`CHANGELOG.md`](./CHANGELOG.md) for the full, versioned list (generated at release).
