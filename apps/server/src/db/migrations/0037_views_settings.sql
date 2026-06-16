-- Per-view `settings` JSON column (Phase 6 views, Cluster 1 / Task 1.0).
--
-- Invariant 10: this is CONFIG of the existing `views` entity, not a new table.
-- Freeform JSON like `filters`/`sort` — unknown keys survive intact. The web/MCP
-- read paths (`db.query.views.findMany`, `db.select().from(views)`) surface the
-- column automatically; the POST handler threads `input.settings ?? {}` into the
-- echoed insert row.
--
-- Additive: a single `ADD COLUMN ... DEFAULT '{}' NOT NULL` needs NO table rebuild
-- (SQLite backfills existing rows with the default). Verified drizzle's migrate()
-- applies a raw ADD-COLUMN migration like any other statement.
--
-- Hand-authored (matching the 0034/0035/0036 precedent): `bun run db:generate`
-- diffs the whole schema against the lagging on-disk meta snapshot (still carries
-- the dropped `memberships` table, lacks `auth_rate_limits`) and so emits
-- destructive rename/recreate noise instead of this clean single ALTER. The
-- matching meta/_journal.json entry (idx 38) is added alongside — drizzle's
-- migrate() silently SKIPS un-journaled files.

ALTER TABLE `views` ADD `settings` text DEFAULT '{}' NOT NULL;
