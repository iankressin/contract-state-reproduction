---
name: Bug report
about: Report something that isn't working as expected
title: ''
labels: bug
assignees: ''
---

## Description

A clear and concise description of the bug.

## Reproduction

The reconstruction is deterministic given the same inputs, so please include them:

- **Contract address**:
- **Portal dataset URL** (`.onPortal(...)`):
- **Deploy block** (`.deployedAt(...)`):
- **Track specs** (`scalar`/`mapping`/`derived`, with slots/keys):
- **Range** (`.run({ from, to })` / `.collect({ from, to })`, or "unbounded follow"):
- **Sink** (`PostgresSink` / `MemorySink` / custom):

A minimal code snippet that triggers the problem is ideal.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the full error (its `code` and message) or wrong values,
and any relevant logs (you can raise verbosity with a `{ logger: createLogger('debug') }`).

## Environment

- `@iankressin/contract-state` version:
- Node.js version (`node --version`, must be ≥ 22.15):
- OS:
- Optional peers installed, if relevant (`pg`/`drizzle-orm`, `solc`):

## Additional context

Anything else that might help.
