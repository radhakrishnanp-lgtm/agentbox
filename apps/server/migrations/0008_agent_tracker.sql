CREATE TABLE `agent_trace` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`machine_id` text NOT NULL,
	`machine_name` text NOT NULL,
	`key_slug` text NOT NULL,
	`cli` text,
	`model` text,
	`status` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`counts` text NOT NULL,
	`events_enc` text NOT NULL,
	`note` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_trace_ts` ON `agent_trace` (`ts`);--> statement-breakpoint
CREATE INDEX `agent_trace_machine` ON `agent_trace` (`machine_id`,`ts`);