CREATE TABLE `vault_key` (
	`id` integer PRIMARY KEY NOT NULL,
	`secret_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "vault_key_single_row" CHECK("vault_key"."id" = 1)
);
