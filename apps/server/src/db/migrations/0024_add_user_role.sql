-- Instance-level role on `users`.
--
-- Step 1 of dropping workspace-as-tenancy-boundary (one instance = one team).
-- Roles will live here rather than on `memberships` (workspace-scoped, slated
-- for removal). Additive only: nothing reads this column yet. Existing rows
-- backfill to 'member' via the NOT NULL DEFAULT; a later task migrates real
-- roles over from `memberships`.
--
-- Hand-authored: `bun run db:generate` regenerates every change since the last
-- on-disk drizzle snapshot (which lags at idx 0006 on this branch), so it would
-- emit a destructive recreate-everything migration. This isolates the single
-- intended column change. Mirrors the existing hand-authored migrations
-- (0007..0022) on this branch.

ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL;
