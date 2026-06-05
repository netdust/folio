-- T-F: backfill the new instance-authority model from the legacy workspace-scoped
-- `memberships` table, ahead of dropping `memberships` and the reserved __system
-- workspace in a later (CONTRACT) task. One instance = one team.
--
-- SECURITY (the whole point of this migration): instance authority
-- (owner/admin of the WHOLE instance) was carried ONLY by membership in the
-- reserved __system workspace. A per-workspace owner ("owner of Galleries") had
-- FOLDER authority, not instance authority — and after the refactor an instance
-- owner BYPASSES every access grant. So users.role is sourced ONLY from the
-- user's __system membership. A per-workspace (non-__system) owner/admin/member
-- becomes a plain workspace_access GRANT, never a role. NEVER "highest role
-- across all workspaces" — that would silently promote every folder-owner to
-- instance-owner (privilege escalation).
--
-- The __system membership itself does NOT become a workspace_access grant: it
-- only ever conveyed instance authority (now on users.role), and __system is
-- being deleted later. Users with no __system membership keep the default
-- 'member'.
--
-- Reads `memberships` (still present) — a one-time data move. Idempotent:
-- INSERT OR IGNORE on the (user_id, workspace_id) PK makes the grant insert
-- safe to re-run; the UPDATE is naturally idempotent.
--
-- Hand-authored: `bun run db:generate` regenerates every change since the last
-- on-disk drizzle snapshot (which lags at idx 0006 on this branch), so it would
-- emit a destructive recreate-everything migration — and it cannot author a data
-- migration regardless. Mirrors the existing hand-authored migrations on this
-- branch. Multi-statement: the two statements (UPDATE users + INSERT
-- workspace_access) are split by the drizzle bun-sqlite breakpoint marker
-- between them.

UPDATE users SET role = (
  SELECT m.role FROM memberships m
  JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = users.id AND w.slug = '__system'
)
WHERE EXISTS (
  SELECT 1 FROM memberships m
  JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = users.id AND w.slug = '__system'
);
--> statement-breakpoint
INSERT OR IGNORE INTO workspace_access (user_id, workspace_id, created_at)
SELECT m.user_id, m.workspace_id, (unixepoch() * 1000)
FROM memberships m
JOIN workspaces w ON w.id = m.workspace_id
WHERE w.slug <> '__system';
