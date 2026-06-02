-- CR-F4 — index memberships.user_id. listWorkspaces + isSystemMember filter by
-- userId, the NON-leading column of the composite PK (workspace_id, user_id),
-- so they full-scan. This index makes them a seek. Forward-only, idempotent-safe.
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);
