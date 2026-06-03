PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
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
);--> statement-breakpoint
INSERT INTO `__new_api_tokens`("id", "workspace_id", "name", "token_hash", "scopes", "agent_id", "project_ids", "created_by", "last_used_at", "created_at") SELECT "id", "workspace_id", "name", "token_hash", "scopes", "agent_id", "project_ids", "created_by", "last_used_at", "created_at" FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);
