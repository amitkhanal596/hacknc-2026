CREATE TABLE `pending_messages` (
	`user_id` text PRIMARY KEY NOT NULL,
	`text` text,
	`image_data` blob,
	`image_mime` text,
	`image_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `groups` ADD `closed_at` integer;