CREATE TABLE `agent_trace_blob` (
	`hash` text PRIMARY KEY NOT NULL,
	`enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent_trace` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_trace` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_trace` ADD `system_hash` text;--> statement-breakpoint
ALTER TABLE `agent_trace` ADD `tools_hash` text;--> statement-breakpoint
ALTER TABLE `agent_trace` ADD `tool_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_trace` ADD `mcp_tool_count` integer DEFAULT 0 NOT NULL;