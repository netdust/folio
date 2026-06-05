-- Per-user access grants: `workspace_access` + `project_access`.
--
-- Step 2 of dropping workspace-as-tenancy-boundary (one instance = one team).
-- Access to a specific workspace/project becomes an explicit invitation-based
-- grant rather than implied by `memberships`. Composite PK = (user, scope) so a
-- grant is unique per pair; the reverse index seeks by scope. Additive only:
-- nothing reads these tables yet — readers land in later tasks.
--
-- Hand-authored: `bun run db:generate` regenerates every change since the last
-- on-disk drizzle snapshot (which lags at idx 0006 on this branch), so it would
-- emit a destructive recreate-everything migration. This isolates the two
-- intended new tables. Mirrors the existing hand-authored migrations
-- (0007..0023) on this branch. Multi-statement: each statement is split by the
-- drizzle bun-sqlite breakpoint marker (see the markers below) — without it only
-- the first statement runs.

CREATE TABLE `workspace_access` (
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `workspace_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_access_ws_idx` ON `workspace_access` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `project_access` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_access_proj_idx` ON `project_access` (`project_id`);
