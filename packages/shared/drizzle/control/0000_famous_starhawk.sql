CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mode_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`from_mode` text,
	`to_mode` text NOT NULL,
	`requested_by` text NOT NULL,
	`accepted` integer NOT NULL,
	`reason` text
);
