#!/usr/bin/env bash
# Black-box test for the migration-journal pre-commit hook.
# Runs the hook against a synthetic staged set (via env override) and
# asserts pass/fail.
set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/pre-commit-migration-journal.sh"
TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT

fail=0

# Case 1: staged migration WITHOUT journal — must FAIL (exit 1).
if FOLIO_HOOK_STAGED_FILES="apps/server/src/db/migrations/9999_test.sql" "$HOOK" > "$TMP/out1" 2>&1; then
  echo "FAIL: hook allowed an orphan migration"; fail=1
else
  grep -q "journal entry" "$TMP/out1" || { echo "FAIL: missing journal-entry message"; fail=1; }
fi

# Case 2: staged migration WITH journal — must PASS (exit 0).
if FOLIO_HOOK_STAGED_FILES=$'apps/server/src/db/migrations/9999_test.sql\napps/server/src/db/migrations/meta/_journal.json' "$HOOK" > "$TMP/out2" 2>&1; then
  : # ok
else
  echo "FAIL: hook rejected a paired migration + journal"; fail=1
fi

# Case 3: no migration in stage — must PASS.
if FOLIO_HOOK_STAGED_FILES="README.md" "$HOOK" > "$TMP/out3" 2>&1; then
  : # ok
else
  echo "FAIL: hook fired on non-migration commit"; fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "OK: 3/3 hook cases"
