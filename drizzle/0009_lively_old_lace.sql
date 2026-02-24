CREATE TABLE `stack_services` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text,
	`env` text,
	`depends_on` text,
	`health_check` text,
	`port` integer,
	`sort_order` integer DEFAULT 0,
	`source` text DEFAULT 'manual' NOT NULL,
	`auto_source` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
