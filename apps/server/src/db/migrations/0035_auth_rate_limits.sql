-- Auth rate-limit counters (M1, audit H6).
--
-- SQLite-backed per-(scope, key) windowed counters — NO sidecar (architectural
-- rule #2: no Redis). Composite PK = (scope, key) so each throttled dimension
-- (an IP, an email) has exactly one counter row, upserted in place. No foreign
-- keys: `key` is a free-form string (IP / email), not an entity reference.
--
-- Hand-authored (matching 1.1's 0034 + the 0025 access-tables precedent):
-- `bun run db:generate` diffs the whole schema against the on-disk drizzle
-- snapshot (which lags on this branch) and would emit destructive noise. This
-- isolates the single new table. The matching `meta/_journal.json` entry (idx 36)
-- is added alongside — drizzle's migrate() silently SKIPS un-journaled files.

CREATE TABLE `auth_rate_limits` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
