#!/usr/bin/env bash
# Regenerates the dependency-structure graph from source.
# Derived entirely from code, so it cannot drift.
#
# Outputs:
#   docs/context/structure/graph.json  (committed — deltas show in PR diffs)
#   docs/context/structure/graph.svg   (gitignored — local visualization; needs Graphviz)
#
# Designed to be safe inside a Stop hook: it never hard-fails. If the language tool
# or Graphviz is missing it skips quietly and leaves the previous graph in place.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 0

OUT="docs/context/structure"
TARGET_FILE=".claude/hooks/target"
mkdir -p "$OUT"

# Source dir to analyze, recorded by /map-init. Defaults to the whole repo.
TARGET="."
if [ -f "$TARGET_FILE" ]; then
  T="$(tr -d '[:space:]' < "$TARGET_FILE")"
  [ -n "$T" ] && TARGET="$T"
fi

have() { command -v "$1" >/dev/null 2>&1; }

# --- TypeScript / JavaScript via madge -------------------------------------
if [ -f package.json ] || [ -f tsconfig.json ] || ls "$TARGET"/*.ts "$TARGET"/*.tsx "$TARGET"/*.js "$TARGET"/*.jsx >/dev/null 2>&1; then
  MADGE=""
  if have madge; then MADGE="madge"
  elif have npx && npx --no-install madge --version >/dev/null 2>&1; then MADGE="npx --no-install madge"
  fi
  if [ -z "$MADGE" ]; then
    echo "update-structure: madge not found — run /map-init to install it. Skipping." >&2
    exit 0
  fi
  $MADGE --extensions ts,tsx,js,jsx,mjs,cjs --json "$TARGET" > "$OUT/graph.json" 2>/dev/null \
    || echo "update-structure: madge JSON pass failed; kept previous graph.json" >&2
  if have dot; then
    $MADGE --extensions ts,tsx,js,jsx,mjs,cjs --image "$OUT/graph.svg" "$TARGET" >/dev/null 2>&1 \
      || echo "update-structure: madge SVG pass failed (Graphviz?)." >&2
  fi
  exit 0
fi

# --- Python via pydeps -----------------------------------------------------
if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ] || ls "$TARGET"/*.py >/dev/null 2>&1; then
  if ! have pydeps; then
    echo "update-structure: pydeps not found — run /map-init to install it. Skipping." >&2
    exit 0
  fi
  pydeps "$TARGET" --show-deps --no-output --no-show > "$OUT/graph.json" 2>/dev/null \
    || echo "update-structure: pydeps JSON pass failed; kept previous graph.json" >&2
  if have dot; then
    pydeps "$TARGET" -o "$OUT/graph.svg" -T svg --no-show >/dev/null 2>&1 \
      || echo "update-structure: pydeps SVG pass failed (Graphviz?)." >&2
  fi
  exit 0
fi

echo "update-structure: no supported stack detected (TS/JS or Python). See README.md to wire another." >&2
exit 0
