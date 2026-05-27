-- Phase 2.6 review fix H3 — add a monotonic `seq` to events for replay ordering.
--
-- G14 introduced a composite cursor `(createdAt > X) OR (createdAt = X AND id > Y)`
-- but `id` is nanoid (random), not insertion-ordered. Same-ms events with ids
-- that lex-sort BEFORE the anchor were silently dropped on Last-Event-Id
-- replay — the very divergence G14 was meant to fix.
--
-- Fix: a per-row monotonic `seq` integer. emitEvent (in lib/events.ts)
-- computes the next seq inside the same tx as the insert; an AFTER INSERT
-- trigger backstops any direct-insert path (tests, future bulk imports)
-- that doesn't go through emitEvent. SQLite's writer lock serializes the
-- max() lookup, so the values are unique and monotonic per insertion
-- order.

ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Backfill existing rows from rowid. SQLite's rowid is monotonic per-insert
-- (events isn't WITHOUT ROWID), so existing rows naturally line up with their
-- insertion order.
UPDATE events SET seq = rowid WHERE seq = 0;
--> statement-breakpoint

CREATE UNIQUE INDEX events_seq_idx ON events(seq);
