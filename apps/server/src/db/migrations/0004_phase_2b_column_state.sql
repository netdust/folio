ALTER TABLE `views` ADD `column_order` text;--> statement-breakpoint
CREATE TABLE `fields_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`table_id` text NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL CHECK (`type` IN ('string','text','number','boolean','date','datetime','select','multi_select','user_ref','url','document_ref','currency')),
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
CREATE UNIQUE INDEX `fields_table_key_idx` ON `fields` (`table_id`,`key`);
