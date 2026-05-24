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
DROP INDEX IF EXISTS `statuses_project_key_idx`;--> statement-breakpoint
ALTER TABLE `fields` ADD `table_id` text REFERENCES tables(id);--> statement-breakpoint
ALTER TABLE `statuses` ADD `table_id` text REFERENCES tables(id);--> statement-breakpoint
ALTER TABLE `views` ADD `table_id` text REFERENCES tables(id);--> statement-breakpoint
ALTER TABLE `documents` ADD `table_id` text REFERENCES tables(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `documents_table_idx` ON `documents` (`table_id`);--> statement-breakpoint
INSERT INTO `tables` (`id`, `project_id`, `slug`, `name`, `order`)
SELECT lower(hex(randomblob(16))), `id`, 'work-items', 'Work Items', 0 FROM `projects`;--> statement-breakpoint
UPDATE `statuses` SET `table_id` = (
	SELECT `tables`.`id` FROM `tables`
	WHERE `tables`.`project_id` = `statuses`.`project_id` AND `tables`.`slug` = 'work-items'
);--> statement-breakpoint
UPDATE `fields` SET `table_id` = (
	SELECT `tables`.`id` FROM `tables`
	WHERE `tables`.`project_id` = `fields`.`project_id` AND `tables`.`slug` = 'work-items'
);--> statement-breakpoint
UPDATE `views` SET `table_id` = (
	SELECT `tables`.`id` FROM `tables`
	WHERE `tables`.`project_id` = `views`.`project_id` AND `tables`.`slug` = 'work-items'
);--> statement-breakpoint
UPDATE `documents` SET `table_id` = (
	SELECT `tables`.`id` FROM `tables`
	WHERE `tables`.`project_id` = `documents`.`project_id` AND `tables`.`slug` = 'work-items'
) WHERE `type` = 'work_item';--> statement-breakpoint
CREATE TABLE `statuses_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`table_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#9ca3af' NOT NULL,
	`category` text DEFAULT 'unstarted' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `statuses_new` (`id`, `project_id`, `table_id`, `key`, `name`, `color`, `category`, `order`)
SELECT `id`, `project_id`, `table_id`, `key`, `name`, `color`, `category`, `order` FROM `statuses`;--> statement-breakpoint
DROP TABLE `statuses`;--> statement-breakpoint
ALTER TABLE `statuses_new` RENAME TO `statuses`;--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_table_key_idx` ON `statuses` (`table_id`,`key`);--> statement-breakpoint
CREATE TABLE `fields_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`table_id` text NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`options` text,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `fields_new` (`id`, `project_id`, `table_id`, `key`, `type`, `label`, `options`, `order`)
SELECT `id`, `project_id`, `table_id`, `key`, `type`, `label`, `options`, `order` FROM `fields`;--> statement-breakpoint
DROP TABLE `fields`;--> statement-breakpoint
ALTER TABLE `fields_new` RENAME TO `fields`;--> statement-breakpoint
CREATE UNIQUE INDEX `fields_table_key_idx` ON `fields` (`table_id`,`key`);--> statement-breakpoint
CREATE TABLE `views_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`table_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`sort` text DEFAULT '[]' NOT NULL,
	`group_by` text,
	`visible_fields` text DEFAULT '[]' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `views_new` (`id`, `project_id`, `table_id`, `name`, `type`, `filters`, `sort`, `group_by`, `visible_fields`, `order`, `is_default`, `created_at`)
SELECT `id`, `project_id`, `table_id`, `name`, `type`, `filters`, `sort`, `group_by`, `visible_fields`, `order`, `is_default`, `created_at` FROM `views`;--> statement-breakpoint
DROP TABLE `views`;--> statement-breakpoint
ALTER TABLE `views_new` RENAME TO `views`;
