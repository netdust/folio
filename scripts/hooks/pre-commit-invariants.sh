#!/usr/bin/env bash
# Runs the ARCHITECTURE-INVARIANTS.md traceability check (scripts/check-invariants.ts)
# when the doc OR server/web source is staged. NON-BLOCKING by design: a stale
# `file:symbol` citation is a doc-maintenance nudge, not a reason to abort a
# commit (blocking on advisory drift just trains people to --no-verify). It
# prints what drifted and exits 0 so the commit proceeds.
#
# To verify the property HOLDS (not just that the doc points at real code), run
# /shakeout — it dispatches the invariant-auditor agent. This hook is the cheap
# always-on layer beneath that.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Allow tests to inject the staged-files list (NL-separated), like the sibling hook.
if [ -n "${FOLIO_HOOK_STAGED_FILES:-}" ]; then
  staged="$FOLIO_HOOK_STAGED_FILES"
else
  staged="$(git diff --cached --name-only --diff-filter=ACMR || true)"
fi

# Only run when something that could move a citation is staged: the doc itself,
# or any server/web TS source (where the cited symbols live).
if ! echo "$staged" | grep -qE '^(ARCHITECTURE-INVARIANTS\.md|apps/(server|web)/src/.*\.tsx?)$'; then
  exit 0
fi

# Run the checker; capture output so we can frame it. The checker exits non-zero
# on hard errors (missing file / undefined symbol) and prints WARN lines for
# line drift. We surface both but never block.
if output="$(cd "$REPO_ROOT" && bun run scripts/check-invariants.ts 2>&1)"; then
  # exit 0 — either fully clean or only warnings (checker treats drift as exit 0).
  if echo "$output" | grep -q '\[WARN '; then
    echo "ℹ ARCHITECTURE-INVARIANTS.md — line numbers drifted (commit not blocked):" >&2
    echo "$output" | grep '\[WARN ' | sed 's/^/    /' >&2
    echo "    Refresh the cited :NN line numbers when convenient." >&2
  fi
else
  # exit non-zero — a citation points at code that no longer exists.
  echo "⚠ ARCHITECTURE-INVARIANTS.md has BROKEN citations (commit not blocked, but fix soon):" >&2
  echo "$output" | grep '\[ERROR\]' | sed 's/^/    /' >&2
  echo "    A convergence point names a file/symbol that no longer exists —" >&2
  echo "    update the doc so reviews + the invariant-auditor can still navigate." >&2
fi

exit 0
