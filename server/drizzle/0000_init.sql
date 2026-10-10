CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_id` text,
	`payment_id` text,
	`actor_id` text,
	`action` text NOT NULL,
	`detail` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_expense` ON `audit_log` (`expense_id`);--> statement-breakpoint
CREATE TABLE `auth_codes` (
	`phone` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dm_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`direction` text NOT NULL,
	`text` text,
	`attachment_url` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dm_user_at` ON `dm_messages` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `expense_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_id` text NOT NULL,
	`user_id` text NOT NULL,
	`cents` integer NOT NULL,
	`status` text NOT NULL,
	`approved_via` text,
	`decided_at` integer,
	`auto_approve_at` integer,
	`dispute_reason` text
);
--> statement-breakpoint
CREATE INDEX `shares_expense` ON `expense_shares` (`expense_id`);--> statement-breakpoint
CREATE INDEX `shares_user` ON `expense_shares` (`user_id`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`payer_id` text NOT NULL,
	`description` text NOT NULL,
	`total_cents` integer NOT NULL,
	`merchant` text,
	`receipt_url` text,
	`receipt_hash` text,
	`receipt_total_cents` integer,
	`receipt_date` text,
	`flags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source_dm_id` text,
	`source_text` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `expenses_group` ON `expenses` (`group_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'trip' NOT NULL,
	`join_code` text NOT NULL,
	`organizer_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_join_code_unique` ON `groups` (`join_code`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`cents` integer NOT NULL,
	`rail` text NOT NULL,
	`status` text NOT NULL,
	`solana_tx_sig` text,
	`simulated` integer DEFAULT false NOT NULL,
	`stripe_payment_intent_id` text,
	`stripe_charge_id` text,
	`stripe_transfer_id` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `payments_group` ON `payments` (`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_pi` ON `payments` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE TABLE `pending_prompts` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`user_id` text NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`last_sent_at` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `group_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`display_name` text,
	`active_group_id` text,
	`wallet_pubkey` text,
	`wallet_secret_enc` text,
	`stripe_account_id` text,
	`stripe_payouts_enabled` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_phone_unique` ON `users` (`phone`);