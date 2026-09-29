CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`ip` text,
	`details` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `audit_ts` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`token_hash` text NOT NULL,
	`user_agent` text NOT NULL,
	`first_ip` text NOT NULL,
	`last_ip` text NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_token_hash` ON `device` (`token_hash`);--> statement-breakpoint
CREATE INDEX `device_revoked` ON `device` (`revoked_at`);--> statement-breakpoint
CREATE TABLE `lockout` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`window_start` integer NOT NULL,
	`locked_until` integer,
	`strikes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`passkey_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`passkey_id`) REFERENCES `passkey`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_ticket_hash` ON `login_ticket` (`ticket_hash`);--> statement-breakpoint
CREATE TABLE `owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`webauthn_user_id` blob NOT NULL,
	`totp_secret_enc` text NOT NULL,
	`totp_last_step` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "owner_single_row" CHECK("owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`aaguid` text NOT NULL,
	`name` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credential_id` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `recovery_code` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`sid_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`ip` text NOT NULL,
	`user_agent` text NOT NULL,
	`cookie_json` text NOT NULL,
	`last_active_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`fresh_auth_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_sid_hash` ON `session` (`sid_hash`);--> statement-breakpoint
CREATE INDEX `session_device` ON `session` (`device_id`);--> statement-breakpoint
CREATE INDEX `session_expires` ON `session` (`expires_at`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setup_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`pending_passkey` text,
	`pending_totp_enc` text,
	`totp_confirmed_step` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_token_hash` ON `setup_token` (`token_hash`);--> statement-breakpoint
CREATE TABLE `webauthn_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`bound_to` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenge_value` ON `webauthn_challenge` (`challenge`);