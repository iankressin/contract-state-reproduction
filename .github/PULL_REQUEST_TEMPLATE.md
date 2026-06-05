<!--
Thanks for contributing! Keep PRs focused and reasonably small.
Fill in the summary and tick the checklist below (delete items that don't apply).
-->

## Summary

<!-- What does this change do, and why? Link any related issue (e.g. "Closes #123"). -->

## Checklist

- [ ] Tests pass locally (`pnpm test`) and cover new behavior.
- [ ] Lint + typecheck are green (`pnpm lint && pnpm typecheck`).
- [ ] Build stays green (`pnpm build`).
- [ ] A changeset is added (`pnpm changeset`) **if this is a user-facing change**.
- [ ] If behavior changed, the living-context artifacts are reconciled in this PR:
      `docs/context/data-flow.mmd` and `docs/context/invariants.md` (see `CLAUDE.md`).
- [ ] Docs are updated if the public API or usage changed (`README.md`, in-source JSDoc).
