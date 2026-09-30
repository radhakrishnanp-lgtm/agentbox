ALTER TABLE `machine` ADD `approve_new_ips` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `machine` ADD `pending_ip` text;--> statement-breakpoint
ALTER TABLE `machine` ADD `pending_ip_at` integer;