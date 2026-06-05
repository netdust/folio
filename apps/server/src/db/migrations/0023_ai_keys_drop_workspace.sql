-- ai_keys: drop workspace_id → instance-level keys, unique (provider, label).
--
-- UPGRADE-SAFE (rewritten 2026-06-05): the original migration FAILED LOUD if
-- `ai_keys` was non-empty (the design assumed a zero-row local DB at migration
-- time). That bricked any real instance carrying per-workspace AI keys: the
-- guard aborted, 0024..0029 never ran, and /auth/me 500'd on the missing
-- users.role column. This version MIGRATES existing keys forward instead:
-- table-rebuild WITHOUT workspace_id, DEDUPED to one row per (provider, label)
-- keeping the NEWEST (max created_at; id as the deterministic tie-break). A
-- workspace that configured anthropic/default and another that configured
-- anthropic/default collapse to the most-recently-created of the two; distinct
-- (provider, label) pairs all survive. No row is silently corrupted — the only
-- loss is an intentional dedup of true duplicates, which the new unique index
-- forbids anyway.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text DEFAULT 'default' NOT NULL,
	`encrypted_key` text NOT NULL,
	`base_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_ai_keys`("id", "provider", "label", "encrypted_key", "base_url", "created_at")
  SELECT "id", "provider", "label", "encrypted_key", "base_url", "created_at"
  FROM `ai_keys` k
  WHERE k.id = (
    SELECT k2.id FROM `ai_keys` k2
    WHERE k2.provider = k.provider AND k2.label = k.label
    ORDER BY k2.created_at DESC, k2.id DESC
    LIMIT 1
  );--> statement-breakpoint
DROP TABLE `ai_keys`;--> statement-breakpoint
ALTER TABLE `__new_ai_keys` RENAME TO `ai_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_provider_label_idx` ON `ai_keys` (`provider`, `label`);
