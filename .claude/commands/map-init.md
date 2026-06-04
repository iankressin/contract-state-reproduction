---
description: Cold-start the living-context workflow for a repo that has none — detect the stack, build the structure graph, trace the real data flow, and seed invariants for human review.
argument-hint: "[optional: source directory, e.g. src]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /map-init — bootstrap codebase context

You are setting up the living-context kit for **this** repository. The goal is not to
write documentation. It is to (1) generate a structure graph that cannot drift, (2)
trace the *real* data flow into a diagram, and (3) capture the tacit invariants — then
hand the human a short review surface that rebuilds their mental model in minutes.

Work through these steps in order. Do not stop early. **Do not mark this command
complete until the human has reviewed the data flow and invariants in step 6.**

## 1. Detect the stack
Inspect the repo to determine the primary language and the source directory.
- TypeScript/JS: `package.json`, `tsconfig.json`. Python: `pyproject.toml`, `setup.py`,
  `requirements.txt`. Go: `go.mod`. Etc.
- Identify the main source directory (`src/`, `lib/`, the package dir). If `$ARGUMENTS`
  was given, use it. If still ambiguous, ask the human which directory holds the source.

## 2. Record the target
Write the chosen source directory (path relative to repo root, **no trailing slash**) to
`.claude/hooks/target`. The Stop hook and `update-structure.sh` read this file to know
what to analyze. Example: `printf 'src' > .claude/hooks/target`.

## 3. Install + run the structure tool
- **TypeScript/JS** → `madge`. Install with `npm i -D madge` (the SVG also needs Graphviz
  `dot`; JSON works without it).
- **Python** → `pydeps`. Install with `pip install pydeps` (SVG also needs Graphviz).
- **Other stacks** → see `README.md` for the tool to swap in (Go → `go-callvis`, etc.)
  and wire it into `.claude/hooks/update-structure.sh`.

Then run `bash .claude/hooks/update-structure.sh` and confirm
`docs/context/structure/graph.json` was produced.

## 4. Trace the real data flow
Read the actual code paths: entry points, how a unit of data enters, what transforms it,
where it lands. Write a Mermaid `flowchart` to `docs/context/data-flow.mmd` that reflects
what the code *actually does*, not an idealized design. Keep nodes concrete — real
module / function / table names. This file is a contract: future turns update it and the
human reviews its diff instead of re-reading the plan.

## 5. Seed invariants
Read the code for assumptions, ordering requirements, dedup keys, idempotency
expectations, and "this only works if…" conditions. Append them to
`docs/context/invariants.md`, one terse line each. Favor the highest-value,
lowest-volume gotchas — the tacit stuff that is not obvious at a glance.

## 6. Hand over the review surface (required)
Present to the human, in chat:
- The data flow as a **numbered walk** — one step per line
  ("1. A request enters at X → 2. it is validated in Y → 3. …").
- Every inferred invariant phrased as a **yes/no question**
  ("Confirm: ingest assumes blocks arrive in order? (y/n)").

Ask them to confirm or correct each, then apply their answers to `data-flow.mmd` and
`invariants.md`.

Confirming or fixing those ~10 lines is the entire point — it is what rebuilds their
mental model in minutes instead of by re-reading the repo. **This command is not finished
until the human has responded to the review.**
