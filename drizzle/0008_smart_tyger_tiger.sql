CREATE TABLE `browser_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `browser_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`sort_order` integer DEFAULT 0,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `browser_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
