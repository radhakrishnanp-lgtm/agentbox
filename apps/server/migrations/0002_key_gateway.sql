CREATE TABLE `ai_key` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`preset` text NOT NULL,
	`upstream` text NOT NULL,
	`auth` text NOT NULL,
	`cli` text,
	`model` text,
	`secret_enc` text NOT NULL,
	`hint` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_key_slug` ON `ai_key` (`slug`);--> statement-breakpoint
CREATE TABLE `gateway_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`day` integer NOT NULL,
	`machine_id` text NOT NULL,
	`key_id` text NOT NULL,
	`key_slug` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`model` text,
	`status` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`request_bytes` integer NOT NULL,
	`response_bytes` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_usage_machine_day` ON `gateway_usage` (`machine_id`,`day`);--> statement-breakpoint
CREATE INDEX `gateway_usage_ts` ON `gateway_usage` (`ts`);--> statement-breakpoint
CREATE TABLE `machine` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pass_hash` text NOT NULL,
	`pass_prefix` text NOT NULL,
	`key_ids` text NOT NULL,
	`ip_rules` text NOT NULL,
	`rpm` integer NOT NULL,
	`daily_token_limit` integer,
	`expires_at` integer,
	`last_seen_at` integer,
	`last_ip` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_pass_hash` ON `machine` (`pass_hash`);