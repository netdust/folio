-- Phase 2.6 review fix H3 — add a monotonic `seq` to events for replay ordering.
--
-- G14 introduced a composite cursor `(createdAt > X) OR (createdAt = X AND id > Y)`
-- but `id` is nanoid (random), not insertion-ordered. Same-ms events with ids
-- that lex-sort BEFORE the anchor were silently dropped on Last-Event-Id
-- replay — the very divergence G14 was meant to fix.
--
-- Fix: a per-row monotonic `seq` integer. emitEvent (in lib/events.ts)
-- computes the next seq inside the same tx as the insert. SQLite's writer
-- lock serializes the max() lookup, so the values are unique and monotonic
-- per insertion order.
--
-- BUG-015 — direct inserts that bypass emitEvent and omit seq will collide
-- on the events_seq_idx UNIQUE constraint after the first such row
-- (DEFAULT 0 + second 0 = duplicate). No AFTER INSERT trigger exists to
-- backstop this (an earlier version of this comment promised one — that
-- promise was never delivered and is removed here). Treat direct inserts
-- into the events table as UNSUPPORTED. Use emitEvent (lib/events.ts) or
-- txWithEvents wrappers; both compute seq atomically with the row insert.

ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Backfill existing rows from rowid. SQLite's rowid is monotonic per-insert
-- (events isn't WITHOUT ROWID), so existing rows naturally line up with their
-- insertion order.
UPDATE events SET seq = rowid WHERE seq = 0;
--> statement-breakpoint

CREATE UNIQUE INDEX events_seq_idx ON events(seq);
