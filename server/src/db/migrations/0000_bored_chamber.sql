CREATE TABLE `receipt_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`expense_id` text,
	`digest` text NOT NULL,
	`mime` text NOT NULL,
	`uploader` text,
	`purpose` text DEFAULT 'expense' NOT NULL,
	`private_base64` text,
	`parser_status` text NOT NULL,
	`extracted_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_group_digest` ON `receipt_assets` (`group_id`,`digest`);--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`method` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text NOT NULL,
	`recipient_destination_snapshot` text NOT NULL,
	`external_reference` text,
	`tx_signature` text,
	`network` text,
	`token_mint` text,
	`signed_transaction` text,
	`last_valid_block_height` integer,
	`chain_expected_json` text,
	`sender_claimed_at` integer,
	`recipient_confirmed_at` integer,
	`verified_at` integer,
	`failure_reason` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `settlement_intents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_positive" CHECK("payment_attempts"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_tx_signature_unique` ON `payment_attempts` (`tx_signature`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_idempotency_key_unique` ON `payment_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `attempt_intent` ON `payment_attempts` (`intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_attempt` ON `payment_attempts` (`intent_id`) WHERE "payment_attempts"."status" NOT IN ('cancelled', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_group` ON `audit_events` (`group_id`);--> statement-breakpoint
CREATE TABLE `settlement_credits` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`group_id` text NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`cents` integer NOT NULL,
	`verification_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `settlement_intents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "credit_positive" CHECK("settlement_credits"."cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_credits_intent_id_unique` ON `settlement_credits` (`intent_id`);--> statement-breakpoint
CREATE TABLE `payment_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`handle_or_address` text NOT NULL,
	`display_hint` text NOT NULL,
	`verified_for_display` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `destination_owner_method` ON `payment_destinations` (`user_id`,`method`);--> statement-breakpoint
CREATE TABLE `payment_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`asset_id` text,
	`note` text,
	`uploader` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `receipt_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`payer_user_id` text,
	`description` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`total_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_message_id` text,
	`created_by` text NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expense_positive" CHECK("expenses"."total_cents" > 0 AND "expenses"."currency" = 'USD')
);
--> statement-breakpoint
CREATE INDEX `expenses_group` ON `expenses` (`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `expense_source` ON `expenses` (`group_id`,`source_message_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`provider_space_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_provider` ON `groups` (`provider`,`provider_space_id`);--> statement-breakpoint
CREATE TABLE `messaging_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_provider` ON `messaging_identities` (`provider`,`provider_user_id`);--> statement-breakpoint
CREATE TABLE `settlement_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`amount_cents` integer NOT NULL,
	`amount_confirmed_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "intent_valid" CHECK("settlement_intents"."amount_cents" > 0 AND "settlement_intents"."amount_confirmed_cents" >= 0 AND "settlement_intents"."amount_confirmed_cents" <= "settlement_intents"."amount_cents" AND "settlement_intents"."from_user_id" != "settlement_intents"."to_user_id" AND "settlement_intents"."currency" = 'USD')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_intents_idempotency_key_unique` ON `settlement_intents` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `intent_group` ON `settlement_intents` (`group_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`text` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`next_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`provider` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`group_id` text NOT NULL,
	`state` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `provider_message_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reminder_state` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`last_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `expense_shares` (
	`expense_id` text NOT NULL,
	`user_id` text NOT NULL,
	`share_cents` integer NOT NULL,
	PRIMARY KEY(`expense_id`, `user_id`),
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "share_nonnegative" CHECK("expense_shares"."share_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE `one_time_tokens` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`binding` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_wallets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`encrypted_secret` text NOT NULL,
	`mint` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_wallets_address_unique` ON `demo_wallets` (`address`);