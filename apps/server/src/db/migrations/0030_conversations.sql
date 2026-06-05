-- Operator cockpit chat: `conversations`, `messages`, `pending_ops`.
--
-- The cockpit becomes a multi-turn operator chat. These three tables are
-- DELIBERATELY walled off from `documents` (invariant 10) and the event stream
-- (invariant 5) — see ARCHITECTURE-INVARIANTS.md "Deliberate exceptions".
-- A conversation must never appear in `/documents`, and emitting an event per
-- chat turn would flood the SSE stream + fire the trigger-matcher.
--
-- `active_run_id` (nullable) is the single-active-turn slot (threat model M14):
-- running = id present. Modeled as a nullable id, NOT a boolean, so a future
-- `cancelling` run-status fits with no migration.
--
-- `pending_ops` is transient gate state for the irreversible-op confirm gate
-- (T7). `params` is recorded immutably and executed verbatim (M6). The
-- `executed_at`/`executed_by` audit columns are nullable, populated only when a
-- confirmed op actually runs (T7) — included now so T7 needs no migration.
--
-- Timestamps follow the house style: `integer` ms-epoch with a `(unixepoch() *
-- 1000)` default (mirrors `instance_skills`, `events`, `reactor_cursors`), NOT
-- text ISO strings. Nullable timestamps (`executed_at`) carry no default.
--
-- Hand-authored: `bun run db:generate` regenerates every change since the last
-- on-disk drizzle snapshot (which lags at idx 0006), so it would emit a
-- destructive recreate-everything migration. This isolates the three new
-- tables. Mirrors the existing hand-authored migrations on this branch.
-- Multi-statement: every statement is split by the drizzle bun-sqlite
-- breakpoint marker — without it only the first statement runs.

CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_by` text NOT NULL,
	`operator_agent_id` text NOT NULL,
	`active_run_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_user_idx` ON `conversations` (`created_by`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`payload` text,
	`run_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conv_seq_idx` ON `messages` (`conversation_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `pending_ops` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`caller_id` text NOT NULL,
	`op` text NOT NULL,
	`params` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`executed_at` integer,
	`executed_by` text
);
