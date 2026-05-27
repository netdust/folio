-- Phase 2.6 review fix B3 — composite (workspace_id, seq) index for SSE replay.
--
-- The replay loop in routes/events.ts pages
--   WHERE workspace_id = ? AND seq > ?
--   ORDER BY seq ASC
--   LIMIT 500
-- The existing indexes are events_workspace_idx(workspace_id, created_at)
-- and events_seq_idx(seq UNIQUE). Neither covers both predicates: SQLite
-- picks one and filters the other row-by-row. At spec scale (10k events/day,
-- multi-workspace, narrowed agents reconnecting in a thundering-herd after a
-- deploy), the result is dozens of SQL round trips per reconnect, each
-- scanning 500 rows before the JS-side filter chain rejects most.
--
-- This composite covers the WHERE + ORDER BY in one seek per page.

CREATE INDEX events_workspace_seq_idx ON events(workspace_id, seq);
