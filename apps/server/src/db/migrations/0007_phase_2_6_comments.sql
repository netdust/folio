-- Phase 2.6 — add 'comment' document type.
-- Widens the documents.type CHECK to accept comment rows.
-- comments: parent_id IS NOT NULL, table_id IS NULL, project_id optional.
-- agent/trigger: project_id IS NULL, parent_id IS NULL (workspace-scoped).
-- work_item/page: project_id IS NOT NULL.
--
-- Uses the standard SQLite table-rebuild idiom (column list verbatim from 0006).

PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
		(`type` = 'comment'                        AND `parent_id` IS NOT NULL AND `table_id` IS NULL)
		OR
		(`type` IN ('agent','trigger')             AND `project_id` IS NULL    AND `parent_id` IS NULL)
		OR
		(`type` IN ('work_item','page')            AND `project_id` IS NOT NULL)
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
CREATE INDEX `documents_comments_idx` ON `documents` (`parent_id`, `created_at` DESC) WHERE `type` = 'comment';--> statement-breakpoint
PRAGMA foreign_keys=ON;
