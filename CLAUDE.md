# Project context

This repo uses a **living-context workflow**. Three artifacts hold the shared mental
model of the codebase. Keep them current — they are how a human stays confident in
agent-written code without re-reading every line.

## The three artifacts

1. **Structure** — `docs/context/structure/graph.json` (+ `graph.svg`).
   The dependency graph, **generated from source** by `.claude/hooks/update-structure.sh`.
   Never edit by hand. It is regenerated every turn and `graph.json` is committed, so
   dependency deltas show up in PR diffs. `graph.svg` is gitignored (local visualization).

2. **Data flow** — `docs/context/data-flow.mmd`.
   A Mermaid diagram of how data *actually* moves end to end. This is a **contract**:
   if a change alters how data flows, update this diagram in the same turn. Reviewers
   read the diff to this file, not the plan.

3. **Invariants** — `docs/context/invariants.md`.
   A terse ledger of assumptions, ordering requirements, dedup keys, idempotency
   expectations, and gotchas — one line each. **Append a line whenever you discover or
   introduce one.** Treat existing lines as binding constraints: do not violate them; if
   a change makes one obsolete, update it.

## Working rules

- Read `docs/context/invariants.md` before changing behavior. The invariants are
  constraints, not suggestions.
- After any source change, reconcile `data-flow.mmd` and `invariants.md`. The Stop hook
  nudges you once per turn if source changed but these files did not.
- Never hand-edit anything under `docs/context/structure/` — it is machine-generated.
- Starting in a repo that has none of these files? Run `/map-init`.

## Prefer interrogation over memory

When you need to understand the system, ask the agent to derive the answer from current
code rather than trusting a stored description:
- "Walk me through how a row flows from X to Y."
- "What does this module assume about its inputs?"
- "What are the failure modes here?"

The three artifacts above make those answers cheap and accurate, and confidence from an
accurate on-demand answer beats confidence from having read everything once.
