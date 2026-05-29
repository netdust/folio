-- Phase 3 (Task C-10b): Reaction Plane — per-reactor replay cursor.
--
-- The durable event dispatcher (lib/event-dispatcher.ts) is the second
-- delivery plane over the append-only `events` table. It polls events by
-- `seq` and fans each one out to registered reactors. Every reactor owns a
-- cursor row here; `last_seq` advances ONLY after a successful react()
-- (cursor-after / at-least-once). On first registration the cursor is seeded
-- at MAX(seq) so a freshly-registered reactor starts "from now" and never
-- replays history.
--
-- Mitigation 49 — a throwing reactor halts its own drain (cursor unchanged →
-- retried next tick) and NEVER rolls back the originating write. Cursor-lag
-- (`MAX(seq) − last_seq`) is the durable truth for reactor health (spec §4b);
-- the in-memory `reactor.halted`/`reactor.recovered` bus events are live-only
-- operational signals, not durable rows.
--
-- Hand-written (no drizzle snapshot, mirroring 0007+): `db:generate`'s
-- snapshot has drifted from the raw migrations (it re-emits events.seq,
-- provider_health, etc.), so the reactor_cursors DDL is transcribed here by
-- hand and journaled manually per [[drizzle-migration-journal]].

CREATE TABLE `reactor_cursors` (
	`reactor_id` text PRIMARY KEY NOT NULL,
	`last_seq` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
