ALTER TABLE `machine` ADD `computer_lock` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `machine` ADD `computer_hash` text;--> statement-breakpoint
ALTER TABLE `machine` ADD `computer_label` text;--> statement-breakpoint
ALTER TABLE `machine` ADD `computer_at` integer;