CREATE TEMP TABLE `__guard_0023_ai_keys_empty` (`row_count` integer CHECK (`row_count` = 0));--> statement-breakpoint
INSERT INTO `__guard_0023_ai_keys_empty` (`row_count`) SELECT COUNT(*) FROM `ai_keys`;--> statement-breakpoint
DROP TABLE `__guard_0023_ai_keys_empty`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text DEFAULT 'default' NOT NULL,
	`encrypted_key` text NOT NULL,
	`base_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_ai_keys`("id", "provider", "label", "encrypted_key", "base_url", "created_at") SELECT "id", "provider", "label", "encrypted_key", "base_url", "created_at" FROM `ai_keys`;--> statement-breakpoint
DROP TABLE `ai_keys`;--> statement-breakpoint
ALTER TABLE `__new_ai_keys` RENAME TO `ai_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_provider_label_idx` ON `ai_keys` (`provider`, `label`);--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
