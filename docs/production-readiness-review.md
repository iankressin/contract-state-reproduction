# Production-Readiness Review — `@subsquid/contract-state`

> **Subject:** `@subsquid/contract-state` v0.1.0 (as of commit `30317e0`)
> **Date:** 2026-06-04
> **Scope:** Assessed against two bars simultaneously — a **public npm package** others
> depend on, *and* an **operationally-hardened** service we run at scale.
> **Method:** Three parallel codebase explorations (core/API, build/packaging, testing/docs/DX),
> with every finding's `file:line` evidence verified against source. Baseline confirmed healthy:
> `pnpm typecheck` is clean and `pnpm test` passes **60 / 1-skipped** offline.
> **This document is an assessment, not a change.** No source was modified.

---

## 1. Executive summary

`@subsquid/contract-state` is a **well-built beta**. The core engine is clean and correct
for its happy path: a small, acyclic module graph; a genuinely nice fluent builder; strict
TypeScript; an 83%-covered offline test suite; and an excellent README with two runnable
examples. Whoever packaged this did the hard architectural work well.

It is **not yet production-ready** — by either bar — for reasons that are almost entirely
*around* the core rather than *in* it:

- **It can't be released safely.** There is no CI, no lint, no release automation, no
  changelog, and no version tags. Nothing stops a broken or unformatted change from being
  published by hand.
- **It can't be operated safely.** There is no error handling around the network/DB seam
  (no retry/backoff), no structured logging, no metrics, and no way to cancel or observe a
  long-running indexer. A live run that hits a transient Portal/Postgres error fails hard.
- **A few P0 correctness gaps silently lose data.** Event-decode failures are swallowed,
  duplicate tracked-variable names overwrite each other, and the decode path uses unchecked
  non-null assertions. None of these surface to the user.

The good news: the gaps are well-understood, independent, and mostly mechanical. The
roadmap in §4 sequences them into roughly **2–3 weeks** of focused work to reach a
defensible 1.0.

**Top blockers (do these first):** typed errors + surfacing silent failures (§3.A/B),
dedup `.track()` (§3.A), wrap the network/DB seam with retry (§3.B), and stand up CI (§3.G).

---

## 2. Readiness scorecard

| Dimension | Grade | One-line |
|---|---|---|
| Core architecture & API design | ✅ Strong | Clean acyclic graph; one obvious way in. |
| Correctness & data integrity | ⚠️ Partial | Happy path solid; **P0 silent-loss bugs** on edges. |
| Error handling & resilience | ❌ Missing | All generic `Error`; **no retry/backoff** on network/DB. |
| Observability & operability | ❌ Missing | `console.log` only; no metrics, hooks, or cancel. |
| Type safety | ✅ Strong | `strict` + `noUncheckedIndexedAccess`; two minor casts. |
| Build, packaging & distribution | ✅ Strong | ESM + tsup + dts + sourcemaps; missing `homepage`/`bugs`. |
| CI/CD & release engineering | ❌ Missing | **No `.github/`**, no changelog, no tags, no automation. |
| Testing & QA | ✅ Strong | 60 offline tests, gated e2e; no enforced threshold. |
| Documentation | ✅ Strong | Excellent README + JSDoc; no generated API site. |
| Project hygiene & community | ❌ Missing | **No lint/format**, no CONTRIBUTING/templates. |
| Security & supply chain | ⚠️ Partial | **String-interpolated SQL**; no dep scanning/SECURITY. |

**Severity legend:** **P0** = correctness/reliability blocker or unsafe to ship • **P1** =
required for a credible public release or safe operation • **P2** = polish for 1.0.

---

## 3. Findings by dimension

### A. Correctness & data integrity

- **[P0] Event-decode failures are swallowed silently.**
  `EventReader.decode()` wraps `decodeEventLog` in a bare `try/catch` that returns `null` on
  *any* exception, and Pass 1 of the pipeline does `if (!args) continue`. A malformed event
  signature, an ABI mismatch, or a missing arg therefore drops mapping keys with **no log,
  no warning, no error** — the resulting `state_value` rows are silently incomplete and the
  user has no signal that anything went wrong.
  *Evidence:* `src/events.ts:18-24`, consumed at `src/pipeline.ts:86-87`.
  *Recommendation:* Distinguish "log didn't match this event" (expected, skip quietly) from
  "event matched but failed to decode" (warn or throw via the new error type in §B). At
  minimum, surface a counter of dropped logs.

- **[P0] Duplicate tracked-variable names overwrite each other.**
  `.track(...)` is varargs and only pushes onto `_specs` — no dedup. Downstream,
  `buildTrackingContext` builds decoders with `decoders.set(p.variable, …)`, so a second
  variable with the same name silently **overwrites** the first in the map. The user gets
  one variable's data where they declared two, with no error.
  *Evidence:* `src/builder.ts:82-85` (no dedup) → `src/pipeline.ts:42` (`Map.set` overwrite).
  *Recommendation:* Reject duplicate `variable` names in `.track()` or in `resolveConfig`
  with a clear `ConfigError`.

- **[P0] Unchecked non-null assertions on the decode path.**
  Both value-emitting lines call `decoders.get(f.variable)!(sd.next)` /
  `decoders.get(label.variable)!(sd.next)`. If a decoder is ever absent (a builder/layout
  logic bug, or the duplicate-name case above), this throws a context-free
  `TypeError: …is not a function` instead of a diagnosable error.
  *Evidence:* `src/pipeline.ts:132` and `src/pipeline.ts:138`.
  *Recommendation:* Look up once, guard, and throw a typed `DecodingError` naming the
  variable if missing.

- **[P1] Weak input validation.**
  `resolveConfig` validates only the address shape and that `trackedVariables` is non-empty.
  The **portal URL is attached without validation**, `deployBlock` is not range-checked, and
  `BlockRange` permits `from > to` and `from < deployBlock` with undefined results.
  *Evidence:* `src/config.ts:83-91`; `src/query.ts:9`.
  *Recommendation:* Validate the URL (parseable `http(s)`), require `deployBlock >= 0`, and
  assert `from <= to` and `from >= deployBlock` at build time.

- **[P2] Reorg rollback exists only in `PostgresSink`.**
  `MemorySink` never rolls back, which is safe *only* because `.collect()` forbids an
  unbounded range. A custom `StateSink` that follows the chain unbounded inherits no
  protection. This constraint is load-bearing but only informally documented.
  *Evidence:* `src/sink.ts:61-76`; `docs/context/invariants.md`.
  *Recommendation:* Document the invariant on the `StateSink` interface and consider a
  runtime guard for unbounded live runs into non-reorg-safe sinks.

### B. Error handling & resilience

- **[P0] No error handling on the network/DB seam — no retry, no backoff.**
  `indexState` builds the Portal stream and awaits `sink.consume`/`pipeTo` with no
  `try/catch`. A transient Portal fetch error or a dropped Postgres connection propagates
  raw and **aborts the whole run**. For a backfill of millions of blocks or a long-lived
  live follow, this is the single biggest operational risk.
  *Evidence:* `src/indexer.ts:25-26`.
  *Recommendation:* Wrap the consume loop with bounded retry + exponential backoff;
  classify retryable (network/5xx/connection) vs fatal (config/decode) failures; surface a
  typed error on give-up.

- **[P0] No typed error hierarchy.**
  Every failure is a generic `throw new Error('…')` with a string message. Consumers cannot
  programmatically distinguish bad input from a network blip from a DB failure — they can
  only string-match. This blocks any caller-side retry or error-routing logic.
  *Evidence:* generic throws across `src/config.ts:84-85`, `src/builder.ts:94,116,119`,
  `src/pipeline.ts:55,60`, `src/sink.ts:56`, and `src/layout.ts`.
  *Recommendation:* Introduce `ContractStateError` subclasses
  (`ConfigError`, `LayoutError`, `DecodingError`, `SinkError`, `PortalError`) and export them.

- **[P1] Validation is late and all-or-nothing.**
  All builder checks run inside `resolve()` at `.run()`/`.collect()` time — never at the
  call site. A user can chain a whole pipeline, forget `.onPortal()`, and only learn at
  runtime. There is also no way to inspect the assembled config before executing.
  *Evidence:* `src/builder.ts:113-129`.
  *Recommendation:* Add a `.validate()` that returns structured problems, and/or a
  `.getConfig()` for inspection; consider validating each input as it is set.

- **[P2] solc compilation is synchronous and blocks the event loop.**
  `compileLayout` reads files and calls the compiler synchronously, freezing the process for
  large contracts with no progress feedback. It runs once at startup, so impact is bounded,
  but it is still a UX cliff on cold start.
  *Evidence:* `src/layout.ts` (`compileLayout`).

### C. Observability & operability

- **[P1] `console.log` instead of a logger.**
  Progress is printed directly to stdout with no levels, no structure, and no way to silence
  it for tests or non-interactive runs.
  *Evidence:* `src/indexer.ts:19,22`.
  *Recommendation:* Accept an optional logger interface (pino-shaped); default to a no-op or
  a minimal console logger.

- **[P1] No lifecycle hooks or metrics.**
  There is no `onBlockProcessed` / `onError` / `onReorg` callback and no counters for
  rows/sec, blocks processed, or chain lag. Operating this at scale means flying blind.
  *Recommendation:* Emit progress/metrics through optional callbacks or an `EventEmitter`.

- **[P1] No lifecycle control or backpressure story.**
  `.run()` is fire-and-forget — there is no abort/cancel handle and no pause/resume. Nor is
  there a documented backpressure strategy if the sink is slower than the stream, which
  risks unbounded memory growth.
  *Evidence:* `src/builder.ts:92-96`, `src/indexer.ts:13-27`.
  *Recommendation:* Accept an `AbortSignal`; document the SDK's backpressure behavior or add
  a bounded queue.

- **[P1] Cursor/resumability only exists for `PostgresSink`.**
  Resumable cursors come from the SDK's `drizzleTarget` inside `PostgresSink`. A custom
  `StateSink` implementer gets no reusable cursor utility and no guidance on how to resume.
  *Evidence:* `src/sink.ts:33-58` (cursor via `drizzleTarget`) vs `src/sink.ts:61-76`
  (`MemorySink`, none).

### D. API design & developer experience

- **[P1] No pre-run inspection/validation surface** (`.validate()` / `.getConfig()`) — see §B.
- **[P2] No built-in file/CSV sink** for `.collect()` users; everyone hand-rolls export.
- **[P2] `derived()` without `.fromSource()` fails late** with a generic "no shape" message
  rather than an eager, specific error. *Evidence:* `src/layout.ts` (`resolvePlans`).

### E. Type safety

Strong overall — `strict` and `noUncheckedIndexedAccess` are on, generics are used well, and
public types are exported. Two minor soft spots:

- **[P2] `as any` to reach valid-but-untyped Portal fields.**
  The `stateDiff` field selection casts past the SDK type because `prev`/`next` are missing
  from it. Documented as a deliberate workaround; remove once the SDK type is fixed.
  *Evidence:* `src/query.ts:18`.
- **[P2] Loose `unknown` / cast-to-`never` in the key path.**
  Event args are `Record<string, unknown>` and `encodeKey` casts `value as never` into viem.
  Low practical risk (viem validates at runtime) but the boundary is untyped.
  *Evidence:* `src/events.ts:10,21`; `src/slots.ts:8`.

### F. Build, packaging & distribution

Strong baseline: `type: module`, ESM-only via **tsup** with `dts: true` + sourcemaps,
`sideEffects: false`, `files: ["dist"]`, optional peer deps correctly marked, and
`publishConfig.access: public`. Gaps:

- **[P1] `package.json` is missing `homepage` and `bugs`.** Both are expected on a public
  package and surface on the npm page. *Evidence:* `package.json` (verified absent).
- **[P2] No declaration maps (`.d.ts.map`).** "Go to definition" in a consumer IDE lands on
  `.d.ts`, not source.
- **[P2] `engines.node: ">=22.15.0"` is aggressive.** It blocks Node 20 LTS users entirely;
  consider whether that reach matters.
- **[P2] ESM-only (no CJS).** Defensible for a Node-22+ library, but it *will* surprise some
  consumers — call it out explicitly in the README.

### G. CI/CD & release engineering

- **[P0] There is no CI whatsoever.** No `.github/` directory exists, so nothing
  lints/typechecks/tests a PR before it merges — or before a manual `npm publish`. This is
  the release-side blocker.
  *Evidence:* `.github/` absent (verified).
  *Recommendation:* A GitHub Actions workflow running `pnpm install`, lint, `pnpm typecheck`,
  and `pnpm test` (+ coverage) on every PR.

- **[P1] No release automation, changelog, or version tags.**
  Publishing is fully manual; there is no `CHANGELOG.md`, no `git tag` (the tag list is
  empty), and no semver discipline. Consumers can't see what changed between versions.
  *Evidence:* `git tag -l` empty; no `CHANGELOG.md` (verified).
  *Recommendation:* Adopt Changesets for versioning + changelog + a tag-triggered publish
  workflow.

- **[P1] No dependency/vulnerability scanning and no `SECURITY.md`** (see §K).

### H. Testing & QA

Strong baseline: Vitest with v8 coverage (~83%), a deterministic **offline** unit + pipeline
suite (60 passing, 1 skipped, ~1s), and e2e/network suites properly gated behind `RUN_E2E`/
`RUN_NET`. Gaps:

- **[P1] No enforced coverage threshold** in `vitest.config.ts`, so coverage can silently
  regress.
- **[P2] Thin coverage on infra paths** — `oracle.ts` (~0%), `indexer.ts` (~25%),
  `PostgresSink` (~47%) — because they need a live Postgres/Portal. Consider a Dockerized
  Postgres job in CI to exercise `PostgresSink`.

### I. Documentation

Strong baseline: a thorough 17 KB README (quick-start, API tables, verification recipe,
known caveats), generous inline JSDoc, and two runnable examples (DAI inline shapes; Uniswap
V3 packed struct). Gaps:

- **[P1] No generated API reference.** No Typedoc/hosted site; consumers rely on IDE hover.
- **[P2] README polish:** no badges (npm/CI/coverage/license), the "works on any EVM chain
  via the Portal URL" point isn't emphasized, and there's no FAQ/troubleshooting section.
- **[P2] Example/spec gaps:** no custom-`StateSink` example, no dedicated "extract mapping
  keys from an event" example, and the temporal/row semantics ("value at block *N* = latest
  row at or before *N*") are only informally stated. Formalize them.

### J. Project hygiene & community

- **[P1] No lint or format tooling.** No ESLint/Prettier/Biome config, no `.editorconfig`,
  no pre-commit hooks, and no `pnpm lint` script. Style is internally consistent today
  (single author) but unenforced and un-CI-able.
  *Evidence:* lint/format/editorconfig files absent (verified).
- **[P2] Missing community files.** No `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, or
  issue/PR templates — expected for a public OSS project. *Evidence:* verified absent.

### K. Security & supply chain

- **[P1] Raw string-interpolated SQL in `PostgresSink.onStart`.**
  Slot labels are inserted by string-building the SQL with `contract`, `slot`, and
  `variable` interpolated directly into the statement. `contract`/`slot` are validated hex,
  but `variable` flows from the storage layout or user-supplied inline config and is **not
  escaped** — an apostrophe in a variable name breaks (or injects into) the statement.
  *Evidence:* `src/sink.ts:42-44`.
  *Recommendation:* Use parameterized inserts (the same Drizzle `tx.insert(...).values(...)`
  pattern already used in `onData`) instead of string interpolation.

- **[P1] No dependency scanning, no `SECURITY.md`.** No `npm audit`/Dependabot in CI and no
  documented disclosure process. *Evidence:* verified absent.

- **[P2] Runtime dependency on an alpha.** `@subsquid/pipes@1.0.0-alpha.9` is pinned (good)
  but is pre-release; breaking changes before 1.0 are likely. Track it to a stable release
  before advertising API stability.

- **[Note] Secrets hygiene is OK.** A local `.env` exists but is gitignored, and a
  committed `.env.example` documents the expected variables. Keep it that way.

---

## 4. Prioritized remediation roadmap

Effort is rough and assumes one engineer familiar with the code. Phases are ordered so the
riskiest, most foundational work lands first; 1a and 1b are independent and can run in
parallel.

### Phase 0 — Correctness & safety (P0) · ~2–4 days
*Make the library stop silently losing data and stop crashing on transient errors.*
1. Introduce the typed error hierarchy (`ConfigError`/`LayoutError`/`DecodingError`/`SinkError`/`PortalError`) and export it. (§B)
2. Surface event-decode failures — separate "no match" from "matched-but-failed"; warn/throw + a dropped-log counter. (§A)
3. Reject duplicate `.track()` variable names. (§A)
4. Replace the non-null assertions on the decode path with guarded lookups. (§A)
5. Wrap the Portal/DB consume loop with retryable-vs-fatal classification + exponential backoff. (§B)

### Phase 1a — Release-ability (P1, npm bar) · ~2–3 days
*Make it safe to publish, repeatedly, without a human gate.*
1. GitHub Actions CI: install → lint → typecheck → test (+coverage) on every PR. (§G)
2. ESLint + Prettier (or Biome) + a `pnpm lint` script. (§J)
3. Changesets + a tag-triggered publish workflow; seed `CHANGELOG.md`; cut the first `v0.1.0` tag. (§G)
4. Add `homepage` + `bugs` to `package.json`; add `SECURITY.md`. (§F, §K)
5. Enable `npm audit`/Dependabot; enforce a coverage threshold in `vitest.config.ts`. (§K, §H)

### Phase 1b — Operability (P1, ops bar) · ~3–5 days
*Make it safe to run at scale and debug when it misbehaves.*
1. Optional logger interface; remove direct `console.log`. (§C)
2. Lifecycle hooks (`onBlockProcessed`/`onError`/`onReorg`) + basic metrics. (§C)
3. `AbortSignal` support; document/implement backpressure. (§C)
4. Reusable cursor utility for custom sinks + guidance. (§C)
5. Eager input validation (URL/range/deploy block) + `.validate()`/`.getConfig()`. (§A, §B, §D)
6. **Parameterize the slot-label SQL** in `PostgresSink.onStart`. (§K)

### Phase 2 — Polish for 1.0 (P2) · ~2–3 days
1. Typedoc site; README badges + FAQ; emphasize multi-chain support. (§I)
2. Custom-sink and event-key examples; formalize temporal/row semantics. (§I)
3. `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / issue + PR templates / `.editorconfig`. (§J)
4. Remove the `as any` once the SDK type is fixed; tighten the key-path types. (§E)
5. Decide Node-20 support; document the ESM-only stance; emit declaration maps. (§F)
6. Track `@subsquid/pipes` to a stable release. (§K)

---

## 5. What's already strong

A fair review names what *not* to touch:

- **Architecture.** Small, acyclic module graph with clean seams (source = Portal,
  sink = Postgres/memory) and a pure, unit-testable `processBatch` core.
- **API design.** The fluent `ContractState.forContract(...)` builder is genuinely good —
  one obvious entry point, no hidden environment fallbacks, a curated export surface.
- **Type safety.** `strict` + `noUncheckedIndexedAccess`, discriminated-union `Plan`,
  exported public types.
- **Build & packaging.** Modern ESM/tsup pipeline with bundled `.d.ts`, sourcemaps,
  tree-shaking hints, and correctly-optional peer deps.
- **Tests.** Deterministic offline suite (60 passing) with properly gated live/e2e tests —
  CI-friendly out of the box.
- **Docs.** A genuinely good README and two real, runnable examples; thorough JSDoc.
- **Living-context discipline.** The `docs/context/` kit (structure graph, data-flow,
  invariants) plus the `.claude/` hooks keep the codebase legible.

The verdict is not "this is rough" — it's "this is a strong core that hasn't yet been
wrapped in the operational and release machinery a production library needs."

---

## Appendix — verification notes

- **Baseline:** `pnpm typecheck` clean; `pnpm test` → 9 files, **60 passed / 1 skipped**, ~1s.
- **Evidence:** every P0/P1 finding cites a `file:line` confirmed against source this review.
- **Negative-space (confirmed absent):** `.github/`, any ESLint/Prettier/Biome/`.editorconfig`,
  `CONTRIBUTING.md`/`CODE_OF_CONDUCT.md`/`CHANGELOG.md`/`SECURITY.md`, git tags, and the
  `homepage`/`bugs` fields in `package.json`.
- **Out of scope:** this review changed no source and did not run the gated e2e/network
  suites (they require Postgres + Portal + RPC access).
