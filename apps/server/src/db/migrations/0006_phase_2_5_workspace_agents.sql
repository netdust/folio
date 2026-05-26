-- Phase 2.5 — workspace-scoped agents.
-- documents.workspace_id (NOT NULL, FK→workspaces); project_id becomes nullable.
-- CHECK locks the type ↔ scope invariant:
--   agent/trigger ⇒ project_id IS NULL
--   work_item/page ⇒ project_id IS NOT NULL
-- api_tokens gain agent_id (FK→documents.id ON DELETE CASCADE) + project_ids (JSON).
--
-- Pre-existing agent/trigger rows are dropped — Phase 2 seeded them as project-scoped,
-- which violates the new CHECK. Their auto-minted tokens go with them.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `documents` ADD `workspace_id` text;--> statement-breakpoint
UPDATE `documents` SET `workspace_id` = (SELECT `workspace_id` FROM `projects` WHERE `projects`.`id` = `documents`.`project_id`);--> statement-breakpoint
DELETE FROM `documents` WHERE `type` IN ('agent','trigger');--> statement-breakpoint
DELETE FROM `api_tokens` WHERE `name` LIKE 'agent:%';--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`workspace_id` text NOT NULL,
	`table_id` text,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`status` text,
	`body` text DEFAULT '' NOT NULL,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`parent_id` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_touched_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CHECK (
		(`type` IN ('agent','trigger') AND `project_id` IS NULL)
		OR
		(`type` IN ('work_item','page') AND `project_id` IS NOT NULL)
	)
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "project_id", "workspace_id", "table_id", "type", "slug", "title", "status", "body", "frontmatter", "parent_id", "created_by", "updated_by", "created_at", "updated_at", "last_touched_at") SELECT "id", "project_id", "workspace_id", "table_id", "type", "slug", "title", "status", "body", "frontmatter", "parent_id", "created_by", "updated_by", "created_at", "updated_at", "last_touched_at" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
CREATE UNIQUE INDEX `documents_project_slug_idx` ON `documents` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `documents_project_type_idx` ON `documents` (`project_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_workspace_type_slug_idx` ON `documents` (`workspace_id`,`type`,`slug`);--> statement-breakpoint
CREATE INDEX `documents_workspace_type_idx` ON `documents` (`workspace_id`,`type`);--> statement-breakpoint
CREATE INDEX `documents_parent_idx` ON `documents` (`parent_id`);--> statement-breakpoint
CREATE INDEX `documents_table_idx` ON `documents` (`table_id`);--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`agent_id` text,
	`project_ids` text,
	`created_by` text,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_api_tokens`("id", "workspace_id", "name", "token_hash", "scopes", "agent_id", "project_ids", "created_by", "last_used_at", "created_at") SELECT "id", "workspace_id", "name", "token_hash", "scopes", NULL, NULL, "created_by", "last_used_at", "created_at" FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
