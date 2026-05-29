import { afterEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { events, reactorCursors } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import type { TestSeed } from '../test/harness.ts';
import type { BusEvent } from './event-bus.ts';
import { eventBus } from './event-bus.ts';
import { type Reactor, runDispatcherOnce } from './event-dispatcher.ts';

afterEach(() => eventBus.__clear());

/**
 * Insert a single durable `events` row directly with an explicit seq, so tests
 * control the seq ordering without relying on emitEvent's MAX(seq)+1 path.
 */
async function seedEvent(db: DB, seed: TestSeed, seq: number, kind: string): Promise<void> {
  await db.insert(events).values({
    id: `ev-${seq}`,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    documentId: `doc-${seq}`,
    kind,
    actor: seed.user.id,
    payload: {},
    createdAt: new Date(),
    seq,
  });
}

async function cursorSeq(db: DB, reactorId: string): Promise<number | undefined> {
  const row = await db.query.reactorCursors.findFirst({
    where: eq(reactorCursors.reactorId, reactorId),
  });
  return row?.lastSeq;
}

test('seeds cursor at MAX(seq) on first registration and does not replay history', async () => {
  const { db, seed } = await makeTestApp();
  await seedEvent(db, seed, 1, 'document.created');
  await seedEvent(db, seed, 2, 'document.created');
  await seedEvent(db, seed, 3, 'document.created');

  const seen: number[] = [];
  const r: Reactor = {
    id: 'test-r',
    kinds: ['document.created'],
    react: async (e) => {
      seen.push(e.seq);
    },
  };

  await runDispatcherOnce(db, [r]); // first run: cursor absent → seed at MAX(seq)=3, no replay
  expect(seen).toEqual([]); // started "from now" — saw nothing historical
  expect(await cursorSeq(db, 'test-r')).toBe(3);

  await seedEvent(db, seed, 4, 'document.created');
  await runDispatcherOnce(db, [r]);
  expect(seen).toEqual([4]); // reactor sees only seq 4
});

test('advances cursor only on success (at-least-once); a throwing react halts and retries next tick', async () => {
  const { db, seed } = await makeTestApp();
  // seed cursor at 0 so the reactor processes from the start
  await db
    .insert(reactorCursors)
    .values({ reactorId: 'test-r', lastSeq: 0, updatedAt: new Date() });
  await seedEvent(db, seed, 1, 'document.created');
  await seedEvent(db, seed, 2, 'document.created');
  await seedEvent(db, seed, 3, 'document.created');

  let attempts = 0;
  const r: Reactor = {
    id: 'test-r',
    kinds: ['document.created'],
    react: async (e) => {
      if (e.seq === 2) {
        attempts++;
        throw new Error('poison');
      }
    },
  };

  await runDispatcherOnce(db, [r]); // 1 ok (cursor→1), 2 throws → halt, cursor stays 1
  expect(await cursorSeq(db, 'test-r')).toBe(1);

  await runDispatcherOnce(db, [r]); // retries from seq 2 → throws again
  expect(attempts).toBe(2); // event 2 re-attempted, never skipped to 3
  expect(await cursorSeq(db, 'test-r')).toBe(1);
});

test('kind-filter advances the cursor past non-matching events (no infinite lag)', async () => {
  const { db, seed } = await makeTestApp();
  await db
    .insert(reactorCursors)
    .values({ reactorId: 'test-r', lastSeq: 0, updatedAt: new Date() });
  await seedEvent(db, seed, 1, 'status.created');
  await seedEvent(db, seed, 2, 'document.created');

  const seen: string[] = [];
  const r: Reactor = {
    id: 'test-r',
    kinds: ['document.created'],
    react: async (e) => {
      seen.push(e.kind);
    },
  };

  await runDispatcherOnce(db, [r]);
  expect(seen).toEqual(['document.created']); // skipped status.created
  expect(await cursorSeq(db, 'test-r')).toBe(2); // advanced PAST the skipped event
});

test('reactor.halted fires exactly ONCE across repeated retry ticks; recovered fires once on recovery', async () => {
  const { db, seed } = await makeTestApp();
  await db
    .insert(reactorCursors)
    .values({ reactorId: 'edge-r', lastSeq: 0, updatedAt: new Date() });
  await seedEvent(db, seed, 1, 'document.created');
  await seedEvent(db, seed, 2, 'document.created');

  const seenSystemEvents: string[] = [];
  const unsub = eventBus.subscribe('any-ws', undefined, (e) => {
    if (e.kind === 'reactor.halted' || e.kind === 'reactor.recovered') {
      seenSystemEvents.push(e.kind);
    }
  });

  let poison = true;
  const r: Reactor = {
    id: 'edge-r',
    kinds: ['document.created'],
    react: async (e) => {
      if (e.seq === 2 && poison) throw new Error('boom');
    },
  };

  await runDispatcherOnce(db, [r]); // halts at 2 → ONE reactor.halted
  await runDispatcherOnce(db, [r]); // still poison → NO second halted (edge-triggered)
  poison = false;
  await runDispatcherOnce(db, [r]); // 2 succeeds → ONE reactor.recovered
  unsub();
  expect(seenSystemEvents).toEqual(['reactor.halted', 'reactor.recovered']);
});

test('reactor.halted broadcast error_summary carries the error CLASS, not the (tenant-data-bearing) message (mitigation 53)', async () => {
  const { db, seed } = await makeTestApp();
  await db
    .insert(reactorCursors)
    .values({ reactorId: 'leak-r', lastSeq: 0, updatedAt: new Date() });
  await seedEvent(db, seed, 1, 'document.created');

  const summaries: unknown[] = [];
  // reactor.halted is workspaceId:null → delivered to EVERY subscriber.
  const unsub = eventBus.subscribe('any-ws', undefined, (e) => {
    if (e.kind === 'reactor.halted') {
      summaries.push((e.payload as Record<string, unknown>).error_summary);
    }
  });

  const r: Reactor = {
    id: 'leak-r',
    kinds: ['document.created'],
    react: async () => {
      throw new Error('secret-tenant-title');
    },
  };

  await runDispatcherOnce(db, [r]);
  unsub();

  expect(summaries).toEqual(['Error']); // the CLASS name, never the message
  expect(summaries).not.toContain('secret-tenant-title');
});

// A system event must transcend BOTH workspace AND project scope. The bus only
// short-circuits the projectId filter on `projectId === null` (BUG-021), so
// emitReactorHealth MUST publish projectId:null (and documentId:null), not omit
// them — otherwise a `?project=X` SSE client never sees reactor.halted.
test('reactor.halted is published with projectId:null and documentId:null (reaches project-scoped subscribers)', async () => {
  const { db, seed } = await makeTestApp();
  await db.insert(reactorCursors).values({ reactorId: 'sys-r', lastSeq: 0, updatedAt: new Date() });
  await seedEvent(db, seed, 1, 'document.created');

  const halted: BusEvent[] = [];
  const unsub = eventBus.subscribe('any-ws', undefined, (e) => {
    if (e.kind === 'reactor.halted') halted.push(e);
  });

  const r: Reactor = {
    id: 'sys-r',
    kinds: ['document.created'],
    react: async () => {
      throw new Error('boom');
    },
  };

  await runDispatcherOnce(db, [r]);
  unsub();

  expect(halted.length).toBe(1);
  expect(halted[0]!.workspaceId).toBeNull();
  expect(halted[0]!.projectId).toBeNull();
  expect(halted[0]!.documentId).toBeNull();
});
