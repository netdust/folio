-- Backfill: existing `list` views ARE spreadsheets; Phase 6 repurposes `list`
-- to the grouped-list renderer, so rewrite them to the new `table` type. The
-- seed default also flips to `table` (seed-project-defaults.ts) so new projects
-- match. `views.type` has NO SQL CHECK (0000 + 0003), so this UPDATE is valid
-- regardless of whether the enum-widen (Task 1.1) has run.
--
-- Hand-authored (matching the 0034/0035/0036/0037 precedent): `bun run
-- db:generate` diffs the whole schema against the lagging on-disk meta snapshot
-- (still carries the dropped `memberships` table, lacks `auth_rate_limits`) and
-- so emits destructive rename/recreate noise instead of this clean single
-- UPDATE. The matching meta/_journal.json entry (idx 39) is added alongside —
-- drizzle's migrate() silently SKIPS un-journaled files.

UPDATE `views` SET `type` = 'table' WHERE `type` = 'list';
