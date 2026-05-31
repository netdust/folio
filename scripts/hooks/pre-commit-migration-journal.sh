#!/usr/bin/env bash
# Refuses commits that add or modify apps/server/src/db/migrations/*.sql
# without also staging apps/server/src/db/migrations/meta/_journal.json.
# Drizzle's migrator silently skips migrations not listed in the journal —
# the symptom is invisible locally and explosive in production.
set -euo pipefail

# Allow tests to inject staged-files list via env (NL-separated).
if [ -n "${FOLIO_HOOK_STAGED_FILES:-}" ]; then
  staged="$FOLIO_HOOK_STAGED_FILES"
else
  staged="$(git diff --cached --name-only --diff-filter=ACMR || true)"
fi

# Find any staged migration .sql files (ignore the _journal.json itself).
migration_files="$(echo "$staged" | grep -E '^apps/server/src/db/migrations/[^/]+\.sql$' || true)"

if [ -z "$migration_files" ]; then
  exit 0
fi

# At least one migration is staged — journal MUST also be staged.
if echo "$staged" | grep -q '^apps/server/src/db/migrations/meta/_journal\.json$'; then
  exit 0
fi

cat >&2 <<EOF
✗ Migration file(s) staged without _journal.json update:

$(echo "$migration_files" | sed 's/^/    /')

Drizzle's migrate() silently skips migrations not listed in
apps/server/src/db/migrations/meta/_journal.json, so a missing
journal entry breaks production without local symptoms.

Add the new migration's entry to _journal.json (idx, version, when,
tag, breakpoints) and stage it:

    git add apps/server/src/db/migrations/meta/_journal.json

See ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_drizzle-migration-journal.md
for the full rule.

To override (emergency only — make a follow-up commit immediately):

    git commit --no-verify ...

EOF
exit 1
