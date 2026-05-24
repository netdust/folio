CREATE TABLE `tables` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tables_project_slug_idx` ON `tables` (`project_id`,`slug`);--> statement-breakpoint
DROP INDEX IF EXISTS `fields_project_key_idx`;--> statement-breakpoint
ALTER TABLE `fields` ADD `table_id` text NOT NULL REFERENCES tables(id);--> statement-breakpoint
CREATE UNIQUE INDEX `fields_table_key_idx` ON `fields` (`table_id`,`key`);--> statement-breakpoint
DROP INDEX IF EXISTS `statuses_project_key_idx`;--> statement-breakpoint
ALTER TABLE `statuses` ADD `table_id` text NOT NULL REFERENCES tables(id);--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_table_key_idx` ON `statuses` (`table_id`,`key`);--> statement-breakpoint
ALTER TABLE `documents` ADD `table_id` text REFERENCES tables(id);--> statement-breakpoint
CREATE INDEX `documents_table_idx` ON `documents` (`table_id`);--> statement-breakpoint
ALTER TABLE `views` ADD `table_id` text NOT NULL REFERENCES tables(id);