ALTER TABLE `projects` ADD `description` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL;