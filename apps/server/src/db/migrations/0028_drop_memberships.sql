-- CONTRACT migration (Phase 4) — the FINAL migration of drop-workspace-tenancy.
-- Drop the legacy workspace-scoped `memberships` table. By this point every
-- production read of `memberships` has been migrated to `users.role` (instance
-- authority) + `workspace_access`/`project_access` (visibility) across Phases
-- 2-4; the `__system` teardown (0027) removed its last rows. Nothing reads it.
--
-- One statement, unconditional. `DROP TABLE` (not IF EXISTS) — the table is
-- guaranteed present here (created at 0001, never dropped), and a hard failure
-- would correctly surface a migration-order mistake rather than silently skip.
--
-- Hand-authored (see the 0027 header for why db:generate is unusable on this
-- branch). The `memberships` export is removed from schema.ts in the same task.

DROP TABLE memberships;
