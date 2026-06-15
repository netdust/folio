#!/usr/bin/env bash
# Pre-commit: reject a staged scripts/build-manifest.ts that is NOT the empty
# dev stub. BLOCKING by design. `bun run build:binary` rewrites the manifest with
# absolute, machine-specific `with { type: 'file' }` import paths (a developer's
# home dir leaks into the file). That generated form must NEVER land in a commit —
# the committed manifest is always the empty stub (WEB_ASSETS / MIGRATIONS empty,
# JOURNAL_PATH '') so a fresh clone compiles and dev takes the on-disk fallback.
#
# This is the INTENTIONAL guard (the Biome quoteStyle trip was only incidental and
# `bun run format` could launder it). After a local build, restore the stub:
#   git checkout scripts/build-manifest.ts
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
MANIFEST="scripts/build-manifest.ts"

# Only inspect when the manifest is actually staged.
if ! git diff --cached --name-only | grep -qx "$MANIFEST"; then
  exit 0
fi

# Read the STAGED blob (index), not the working tree — that is what would commit.
STAGED="$(git show ":$MANIFEST" 2>/dev/null || true)"

# The stub has empty records: `export const WEB_ASSETS: Record<string, string> = {};`
# A generated manifest opens the object on its own line and lists entries. Reject
# anything that is not the single-line empty form.
if ! printf '%s' "$STAGED" | grep -qE 'export const WEB_ASSETS: Record<string, string> = \{\};'; then
  echo "✗ $MANIFEST is staged in its GENERATED (non-stub) form — it leaks absolute" >&2
  echo "  machine paths and must not be committed. Restore the stub first:" >&2
  echo "    git checkout $MANIFEST && git add $MANIFEST" >&2
  exit 1
fi
