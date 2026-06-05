# Contributing to `@iankressin/contract-state`

Thanks for your interest in improving this library. This guide covers local setup, the
checks you must pass, the living-context workflow this repo uses, and what we expect on a
pull request.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js ≥ 22.15** — the package is ESM-only and targets modern Node.
- **[pnpm](https://pnpm.io)** — the package manager (version is pinned via the
  `packageManager` field in `package.json`; `corepack enable` will use the right one).
- **Docker** — only for the gated live end-to-end tests (a local Postgres).

## Getting started

```bash
git clone https://github.com/iankressin/contract-state-reproduction.git
cd contract-state-reproduction
pnpm install
```

To run the bundled example against a live Portal + local Postgres:

```bash
cp .env.example .env   # set DB_URL, PORTAL_URL, RPC_URL (RPC is only used by `pnpm verify`)
pnpm db:up             # start Postgres on :5432 (docker compose)
pnpm example           # backfill DAI deploy → head, then follow live
pnpm db:down           # stop Postgres when done
```

## The checks (run these before pushing)

CI runs lint, typecheck, and the offline test suite with coverage thresholds. Reproduce it
locally with:

```bash
pnpm lint          # Biome: formatting + lint rules (use `pnpm lint:fix` to autofix)
pnpm typecheck     # tsc --noEmit (strict)
pnpm test          # unit + deterministic pipeline integration — fully offline, no infra
pnpm test:cov      # the same, with a coverage report (what CI gates on)
pnpm build         # tsup → dist/index.js (ESM) + dist/index.d.ts — must stay green
```

Formatting is enforced by [Biome](https://biomejs.dev) (config in `biome.json`): 2-space
indent, single quotes, no semicolons, trailing commas, line width 160. An `.editorconfig`
mirrors these so most editors format correctly on save. Do not hand-format against the
grain — run `pnpm lint:fix`.

> **Note — declaration maps are deferred.** The build emits `dist/index.d.ts` via tsup's
> bundled-dts pipeline (`dts: true`, rollup-plugin-dts), which does **not** emit
> `dist/*.d.ts.map`. The only tsup path that honors `declarationMap` is `experimentalDts`,
> and it requires the extra `@microsoft/api-extractor` dependency and currently breaks the
> single-file `dist/index.d.ts` bundle — so source-mapped declarations are deferred rather
> than complicate the working build.

### Optional / gated tests

These need external services and are **not** part of the default `pnpm test`:

```bash
pnpm db:up && pnpm test:e2e   # live e2e: indexes a DAI window + a Uniswap V3 pool through Postgres
pnpm test:net                 # exercises the remote-solc download path (network)
```

### Verifying against the chain

The repo ships scripts that cross-check reconstructed state against on-chain reads:

```bash
pnpm smoke    # confirm the Portal serves storage diffs for a contract/range
pnpm verify   # reconstructed scalar/mapping/nested values == eth_getStorageAt + accessors
```

## The living-context workflow

This repo keeps a **shared mental model** of the codebase in three artifacts under
`docs/context/`. They let a reviewer trust agent-written code without re-reading every line.
If your change touches behavior, keep them current **in the same PR** — see
[`CLAUDE.md`](./CLAUDE.md) for the full rules.

1. **Structure** — `docs/context/structure/graph.json` (+ rendered `graph.mmd`). The
   dependency graph, **generated from source**. Never edit it by hand; it is regenerated and
   committed so dependency deltas show up in the PR diff.
2. **Data flow** — `docs/context/data-flow.mmd`. A Mermaid diagram of how data actually
   moves end to end. It is a contract: if your change alters the flow, update this diagram.
3. **Invariants** — `docs/context/invariants.md`. A terse ledger of assumptions, ordering
   requirements, dedup keys, and gotchas — one line each. Treat existing lines as **binding
   constraints**; append a line when you discover or introduce one.

API documentation is generated from the dense in-source JSDoc with
[Typedoc](https://typedoc.org): `pnpm docs:api` writes HTML to `docs/api/` (gitignored).

## Pull requests

- **Branch** off `main`; keep PRs focused and reasonably small.
- **Pass the checks** above (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- **Add tests** for new behavior. The default suite is offline and deterministic — keep it
  that way (gate anything needing Postgres/Portal/RPC behind the `RUN_E2E` / `RUN_NET`
  env flags, as the existing tests do).
- **Reconcile the context artifacts** (data-flow + invariants) when behavior changes.
- **Add a changeset** for any user-facing change so the version bump and CHANGELOG entry
  are generated at release:

  ```bash
  pnpm changeset
  ```

  Pick the semver bump (patch / minor / major) and describe the change in user-facing terms.
  Purely internal changes (refactors, tests, docs, CI) don't need one.

## Reporting bugs & requesting features

Use the GitHub issue templates (bug report / feature request). For bugs, the
reconstruction is deterministic given the same contract, deploy block, track specs, and
range — please include those plus the Portal dataset URL so the issue is reproducible.
