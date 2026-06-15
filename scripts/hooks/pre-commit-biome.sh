#!/usr/bin/env bash
# Pre-commit: Biome must report 0 errors before a commit lands. BLOCKING by
# design (unlike pre-commit-invariants.sh, which is advisory) — main stays at
# 0 lint errors, the invariant 0.4 established. `bun run lint` = `biome check .`
# (check only, no autofix). Run `bun run format` to auto-fix style.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if ! bun run lint > /dev/null 2>&1; then
  echo "✗ Biome found errors. Run 'bun run lint' to see them; 'bun run format' to auto-fix style." >&2
  exit 1
fi
