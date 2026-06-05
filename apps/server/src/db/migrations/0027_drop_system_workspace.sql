-- CONTRACT migration (Phase 4): tear down the reserved `__system` library
-- workspace. Its load-bearing pieces were rehomed in code (folio skill →
-- `instance_skills`; instance authority → `users.role`; operator → runtime
-- singleton), so the workspace + its projects/documents/memberships are now
-- DEAD data. One instance = one team — there is no reserved tenancy row.
--
-- Idempotent + guarded: every delete is keyed off the `__system` workspace id
-- via a subselect, so on an instance that NEVER had `__system` (a fresh install
-- post-refactor) each statement matches zero rows and is a harmless no-op.
-- Explicit dependency-order deletes (documents → projects → memberships →
-- workspace) rather than relying on FK cascade, so the teardown is correct even
-- if a future schema change loosens an ON DELETE clause.
--
-- Hand-authored: `bun run db:generate` lags at the idx-0006 on-disk snapshot on
-- this branch and would emit a destructive recreate-everything migration; it
-- cannot author a data teardown regardless. Mirrors the hand-authored
-- 0007..0026 migrations. Multi-statement: each is split by the drizzle
-- bun-sqlite breakpoint marker — without it only the first statement runs.

DELETE FROM documents
WHERE workspace_id IN (SELECT id FROM workspaces WHERE slug = '__system');
--> statement-breakpoint
DELETE FROM projects
WHERE workspace_id IN (SELECT id FROM workspaces WHERE slug = '__system');
--> statement-breakpoint
DELETE FROM memberships
WHERE workspace_id IN (SELECT id FROM workspaces WHERE slug = '__system');
--> statement-breakpoint
DELETE FROM workspaces WHERE slug = '__system';
