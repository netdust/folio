CREATE TABLE `ai_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`label` text DEFAULT 'default' NOT NULL,
	`encrypted_key` text NOT NULL,
	`base_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_workspace_provider_idx` ON `ai_keys` (`workspace_id`,`provider`,`label`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
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
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_project_slug_idx` ON `documents` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `documents_project_type_idx` ON `documents` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `documents_parent_idx` ON `documents` (`parent_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`document_id` text,
	`kind` text NOT NULL,
	`actor` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_workspace_idx` ON `events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_document_idx` ON `events` (`document_id`);--> statement-breakpoint
CREATE TABLE `fields` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`options` text,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fields_project_key_idx` ON `fields` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_links_token_idx` ON `magic_links` (`token_hash`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_workspace_slug_idx` ON `projects` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE TABLE `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#9ca3af' NOT NULL,
	`category` text DEFAULT 'unstarted' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_project_key_idx` ON `statuses` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `views` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`sort` text DEFAULT '[]' NOT NULL,
	`group_by` text,
	`visible_fields` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);