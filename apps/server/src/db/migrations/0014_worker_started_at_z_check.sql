-- Phase 3 (R11 fix, post-review-of-review): defense-in-depth at the DB
-- layer for the lex-compare invariant `worker_started_at` must be a Z-
-- suffixed UTC ISO timestamp. The schema-level Zod validator already
-- enforces this at the createRun / transitionRun entry point, but
-- direct-SQL writers (future migrations, CLI tools, hand-edited rows,
-- ANY code path that bypasses Zod) could otherwise write a `+02:00`-
-- format timestamp that sorts before `Z` lexicographically — breaking
-- `recoverOrphanRuns`'s `worker_started_at < threshold` predicate.
--
-- CHECK constraint at the storage layer makes the invariant DB-enforced
-- rather than parser-only. Run rows that violate this would fail INSERT
-- or UPDATE with SQLITE_CONSTRAINT_CHECK — a load-bearing safeguard for
-- mitigation 37's orphan-recovery boundary.
--
-- The constraint matches NULL (cleared on terminal transitions) OR a
-- string ending in 'Z' (UTC ISO). GLOB is SQLite's pattern-match
-- operator; '*Z' matches any string ending in Z. Cheap, runs on every
-- INSERT/UPDATE that touches the column.
--
-- Only the `agent_run` type's frontmatter has this field; the CHECK
-- predicate is scoped to that type so non-run rows are unaffected.
--
-- TWO PATHS to add a CHECK constraint to an existing SQLite table:
--   1. ALTER TABLE ADD COLUMN with constraint — not applicable here
--      (column already exists inside a JSON blob, not as a column).
--   2. CHECK on the table itself, which requires recreating the table.
--
-- Since `worker_started_at` lives inside `documents.frontmatter` (JSON
-- text), the constraint targets a json_extract expression. SQLite
-- supports CHECK on table-level expressions, but adding such a
-- constraint requires the table-recreation dance.
--
-- For Phase 3 v1, simpler defense-in-depth: an INSERT/UPDATE TRIGGER
-- that aborts if the constraint is violated. Same enforcement semantics
-- without the table-recreation cost.

CREATE TRIGGER IF NOT EXISTS documents_agent_run_worker_started_at_z_check_insert
BEFORE INSERT ON documents
FOR EACH ROW
WHEN NEW.type = 'agent_run'
  AND json_extract(NEW.frontmatter, '$.worker_started_at') IS NOT NULL
  AND json_extract(NEW.frontmatter, '$.worker_started_at') NOT GLOB '*Z'
BEGIN
  SELECT RAISE(ABORT, 'agent_run worker_started_at must be a Z-suffixed UTC ISO timestamp');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS documents_agent_run_worker_started_at_z_check_update
BEFORE UPDATE ON documents
FOR EACH ROW
WHEN NEW.type = 'agent_run'
  AND json_extract(NEW.frontmatter, '$.worker_started_at') IS NOT NULL
  AND json_extract(NEW.frontmatter, '$.worker_started_at') NOT GLOB '*Z'
BEGIN
  SELECT RAISE(ABORT, 'agent_run worker_started_at must be a Z-suffixed UTC ISO timestamp');
END;
