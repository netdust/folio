ALTER TABLE `views` ADD `order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `views` ADD `is_default` integer DEFAULT false NOT NULL;