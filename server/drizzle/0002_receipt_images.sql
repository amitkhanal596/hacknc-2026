CREATE TABLE `receipt_images` (
	`expense_id` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL
);
