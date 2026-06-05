-- Instance-level agent skills: `instance_skills`.
--
-- Part of dropping workspace-as-tenancy-boundary (one instance = one team).
-- Skills move off `page` documents in the reserved `__system` workspace onto
-- this dedicated instance-level table. Additive only: nothing reads or seeds it
-- yet — the loader + seeder land in a later task.
--
-- SECURITY: `trusted` is a TYPED column (integer 0/1), never a key inside the
-- `frontmatter` JSON blob. A trusted skill loads as trusted instructions into an
-- agent's system prompt, so trust is privilege. As its own column, wholesale
-- frontmatter writes (skill edit, bulk import, restore) physically cannot forge
-- it — only a dedicated mutator can. That makes trust-forging impossible.
--
-- Hand-authored: `bun run db:generate` regenerates every change since the last
-- on-disk drizzle snapshot (which lags at idx 0006 on this branch), so it would
-- emit a destructive recreate-everything migration. This isolates the one
-- intended new table. Mirrors the existing hand-authored migrations
-- (0007..0024) on this branch. Multi-statement: the two statements (CREATE
-- TABLE + CREATE UNIQUE INDEX) are split by the drizzle bun-sqlite breakpoint
-- marker between them — without it only the first statement runs.

CREATE TABLE `instance_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`trusted` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instance_skills_name_idx` ON `instance_skills` (`name`);
