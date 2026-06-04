#!/usr/bin/env bash
# Stop hook: keeps the living-context files honest after every turn.
#
#   1. Always regenerates the structure graph (it is derived from source, can't drift).
#   2. If SOURCE changed this turn but data-flow.mmd / invariants.md did NOT, it blocks
#      once with a nudge to reconcile them.
#
# One nudge per turn: it honors `stop_hook_active` so it never blocks twice / loops.
# Stays quiet when the model files were touched, or when only non-source changed.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 0

INPUT="$(cat)"

# Don't block twice: if we are here because of a previous block, stay silent.
case "$INPUT" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

# 1. Always refresh the structure graph (can't drift — it's computed from source).
bash "$ROOT/.claude/hooks/update-structure.sh" >/dev/null 2>&1 || true

# No git repo? Nothing to diff against — done.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

FLOW="docs/context/data-flow.mmd"
INV="docs/context/invariants.md"

# -uall forces per-file listing. Without it, git collapses an entirely-untracked
# directory to a single entry, which can hide both new source files and the model files.
CHANGED="$(git status --porcelain -uall | sed 's/^...//')"
[ -z "$CHANGED" ] && exit 0

# Were the living-context files touched this turn?
MODEL_TOUCHED=0
if printf '%s\n' "$CHANGED" | grep -qxe "$FLOW" -e "$INV"; then
  MODEL_TOUCHED=1
fi

# Did any *source* file change? (ignore the model files and the generated structure dir)
SOURCE_TOUCHED=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    "$FLOW"|"$INV") continue ;;
    docs/context/structure/*) continue ;;
  esac
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.rb|*.php|\
    *.c|*.h|*.cpp|*.cc|*.hpp|*.cs|*.swift|*.kt|*.kts|*.scala|*.sol|*.vue|*.svelte)
      SOURCE_TOUCHED=1
      break
      ;;
  esac
done <<EOF
$CHANGED
EOF

if [ "$SOURCE_TOUCHED" -eq 1 ] && [ "$MODEL_TOUCHED" -eq 0 ]; then
  cat >&2 <<'MSG'
Source changed this turn but the living-context files did not. Before finishing,
reconcile them with the change you just made:
  - docs/context/data-flow.mmd  — update the flow if data now moves differently
  - docs/context/invariants.md  — add any assumption/gotcha you introduced or discovered
If neither truly needs to change, say so in one line and stop.
MSG
  exit 2
fi

exit 0
